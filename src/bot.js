'use strict';

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { Agency, Agent, Property, Lead, Meeting, FAQ, Session, MessageLog } = require('./models');
const {
  detectLang, isGreeting, matchFAQ,
  formatPropertyList, formatPropertyDetail, formatMainMenu,
  formatVisitReceipt, generateToken, getSellQuestion, getVisitQuestion, parseBudget
} = require('./utils/engine');

// ──────────────────────────────────────────────
// GLOBAL SESSION STORES
// ──────────────────────────────────────────────
const clients      = new Map();  // agencyId -> WhatsApp Client
const qrCodes      = new Map();  // agencyId -> base64 QR
const statuses     = new Map();  // agencyId -> status string

// ──────────────────────────────────────────────
// INITIALIZE / RESTART CLIENT FOR AN AGENCY
// ──────────────────────────────────────────────
async function initClient(agency) {
  const agencyId = agency._id.toString();

  // Destroy existing if any
  if (clients.has(agencyId)) {
    try { await clients.get(agencyId).destroy(); } catch (_) {}
    clients.delete(agencyId);
  }

  statuses.set(agencyId, 'initializing');
  qrCodes.delete(agencyId);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: agencyId }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    }
  });

  client.on('qr', async (qr) => {
    try {
      const base64 = await QRCode.toDataURL(qr);
      qrCodes.set(agencyId, base64);
      statuses.set(agencyId, 'qr_pending');
      console.log(`[${agency.name}] QR Code generated`);
    } catch (err) {
      console.error(`[${agency.name}] QR error:`, err.message);
    }
  });

  client.on('ready', () => {
    statuses.set(agencyId, 'connected');
    qrCodes.delete(agencyId);
    console.log(`[${agency.name}] WhatsApp Ready!`);
  });

  client.on('authenticated', () => {
    statuses.set(agencyId, 'authenticated');
    console.log(`[${agency.name}] Authenticated`);
  });

  client.on('auth_failure', (msg) => {
    statuses.set(agencyId, 'auth_failed');
    console.error(`[${agency.name}] Auth failure:`, msg);
  });

  client.on('disconnected', (reason) => {
    statuses.set(agencyId, 'disconnected');
    console.log(`[${agency.name}] Disconnected:`, reason);
  });

  client.on('message', async (msg) => {
    await handleIncoming(client, msg, agency);
  });

  clients.set(agencyId, client);
  await client.initialize();
  return client;
}

// ──────────────────────────────────────────────
// HANDLE INCOMING MESSAGE
// ──────────────────────────────────────────────
async function handleIncoming(client, msg, agency) {
  // Skip group messages, non-text that isn't relevant
  if (msg.isGroupMsg) return;
  if (!msg.body && msg.type !== 'chat') return;

  const rawPhone = msg.from.replace('@c.us', '');
  const body     = (msg.body || '').trim();
  const agencyId = agency._id;

  // Log incoming message
  try {
    await MessageLog.create({
      agencyId, phone: rawPhone, direction: 'in', body, type: msg.type
    });
    await Agency.findByIdAndUpdate(agencyId, { $inc: { messageCount: 1 } });
  } catch (_) {}

  // Get or create session
  let session = await Session.findOne({ agencyId, phone: rawPhone });
  if (!session) {
    session = await Session.create({ agencyId, phone: rawPhone });
  }

  const lang = detectLang(body) || session.lang || 'en';
  session.lang = lang;
  session.lastActive = new Date();

  try {
    await processMessage(client, msg, agency, session, body, rawPhone, lang);
  } catch (err) {
    console.error(`[${agency.name}] Message processing error:`, err.message);
    await safeSend(client, msg.from, lang === 'ur'
      ? '⚠️ کچھ غلطی ہوئی۔ دوبارہ کوشش کریں یا 0 لکھیں۔'
      : '⚠️ Something went wrong. Please try again or type 0 for menu.');
  }
}

// ──────────────────────────────────────────────
// CORE MESSAGE PROCESSOR
// ──────────────────────────────────────────────
async function processMessage(client, msg, agency, session, body, rawPhone, lang) {
  const lower = body.toLowerCase().trim();
  const agencyId = agency._id;

  // Global: 0 or "menu" → reset to main menu
  if (lower === '0' || lower === 'menu' || lower === 'مینو') {
    session.step = 'MENU';
    session.pending = {};
    session.markModified('pending');
    await session.save();
    await safeSend(client, msg.from, formatMainMenu(agency.name, lang));
    return;
  }

  // FAQ check (before flow) - but not during visit/sell collection
  const collectingSteps = ['VISIT_NAME', 'VISIT_PHONE', 'VISIT_DATE', 'SELL_TYPE', 'SELL_AREA', 'SELL_LOCATION', 'SELL_PRICE', 'SELL_CNAME', 'SELL_CPHONE'];
  if (!collectingSteps.includes(session.step)) {
    const faqs = await FAQ.find({ agencyId, isActive: true });
    const faqMatch = matchFAQ(body, faqs);
    if (faqMatch) {
      await FAQ.findByIdAndUpdate(faqMatch._id, { $inc: { hitCount: 1 } });
      await safeSend(client, msg.from, `❓ *${faqMatch.question}*\n\n${faqMatch.answer}\n\n_0 - ${lang === 'ur' ? 'مین مینو' : 'Main Menu'}_`);
      await session.save();
      return;
    }
  }

  // Greeting → show menu
  if (session.step === 'START' || isGreeting(body)) {
    session.step = 'MENU';
    session.pending = {};
    session.markModified('pending');
    await session.save();
    await safeSend(client, msg.from, formatMainMenu(agency.name, lang));
    return;
  }

  // ── MENU STEP ──
  if (session.step === 'MENU') {
    const choice = parseMenuChoice(lower);
    if (choice === 'buy' || choice === 'rent' || choice === 'commercial') {
      session.step = 'ASK_BUDGET';
      session.pending = { type: choice };
      session.markModified('pending');
      await session.save();
      await safeSend(client, msg.from, lang === 'ur'
        ? `💰 آپ کا بجٹ کتنا ہے؟\n(مثلاً: 50 لاکھ، 1 کروڑ، یا "کوئی بھی")`
        : `💰 What is your budget?\n(e.g. 50 Lakh, 1 Crore, or "any")`);
      return;
    }
    if (choice === 'sell') {
      session.step = 'SELL_TYPE';
      session.pending = {};
      session.markModified('pending');
      await session.save();
      await safeSend(client, msg.from, getSellQuestion('propertyType', lang));
      return;
    }
    if (choice === 'faq') {
      const faqs = await FAQ.find({ agencyId, isActive: true }).limit(5);
      if (faqs.length === 0) {
        await safeSend(client, msg.from, lang === 'ur'
          ? '📖 ابھی کوئی سوال نہیں ہے۔ ہم سے براہ راست رابطہ کریں۔\n\n0 - مین مینو'
          : '📖 No FAQs available yet. Contact us directly.\n\n0 - Main Menu');
      } else {
        const lines = faqs.map((f, i) => `${i + 1}. ${f.question}`).join('\n');
        await safeSend(client, msg.from, (lang === 'ur'
          ? `❓ *اکثر پوچھے گئے سوالات:*\n\n${lines}\n\nسوال کا نمبر لکھیں یا اپنا سوال لکھیں۔\n0 - مین مینو`
          : `❓ *Frequently Asked Questions:*\n\n${lines}\n\nReply with a number or ask your question.\n0 - Main Menu`));
        session.step = 'FAQ_LIST';
        session.pending = { faqs: faqs.map(f => f._id.toString()) };
        session.markModified('pending');
      }
      await session.save();
      return;
    }
    // Unrecognised
    await safeSend(client, msg.from, formatMainMenu(agency.name, lang));
    return;
  }

  // ── FAQ LIST ──
  if (session.step === 'FAQ_LIST') {
    const faqIds = (session.pending && session.pending.faqs) || [];
    const num = parseInt(lower);
    if (!isNaN(num) && num >= 1 && num <= faqIds.length) {
      const faq = await FAQ.findById(faqIds[num - 1]);
      if (faq) {
        await FAQ.findByIdAndUpdate(faq._id, { $inc: { hitCount: 1 } });
        await safeSend(client, msg.from, `❓ *${faq.question}*\n\n${faq.answer}\n\n0 - ${lang === 'ur' ? 'مین مینو' : 'Main Menu'}`);
      }
    } else {
      await safeSend(client, msg.from, formatMainMenu(agency.name, lang));
      session.step = 'MENU';
    }
    await session.save();
    return;
  }

  // ── ASK BUDGET ──
  if (session.step === 'ASK_BUDGET') {
    let maxPrice = null;
    if (lower !== 'any' && lower !== 'کوئی بھی') {
      maxPrice = parseBudget(body);
    }
    session.pending.budget = maxPrice;
    session.pending.budgetText = body;
    session.step = 'ASK_AREA';
    session.markModified('pending');
    await session.save();
    await safeSend(client, msg.from, lang === 'ur'
      ? `📍 کس علاقے میں پراپرٹی چاہیے؟\n(شہر یا علاقے کا نام لکھیں، یا "کوئی بھی" لکھیں)`
      : `📍 Which area are you looking in?\n(Enter city or area name, or "any")`);
    return;
  }

  // ── ASK AREA ──
  if (session.step === 'ASK_AREA') {
    const area = (lower === 'any' || lower === 'کوئی بھی') ? null : body;
    session.pending.area = area;
    session.markModified('pending');
    await session.save();

    // Build query
    const query = {
      agencyId,
      type: session.pending.type,
      isActive: true,
      isSold: false
    };
    if (session.pending.budget) query.price = { $lte: session.pending.budget };
    if (area) query.$or = [
      { city:     { $regex: area, $options: 'i' } },
      { location: { $regex: area, $options: 'i' } },
      { address:  { $regex: area, $options: 'i' } }
    ];

    const props = await Property.find(query).sort({ isFeatured: -1, createdAt: -1 }).limit(20);
    session.pending.results = props.map(p => p._id.toString());
    session.pending.page    = 0;
    session.step = 'RESULTS';
    session.markModified('pending');
    await session.save();

    await safeSend(client, msg.from, formatPropertyList(props, lang, 0));
    return;
  }

  // ── RESULTS ──
  if (session.step === 'RESULTS') {
    const results = session.pending.results || [];
    let page = session.pending.page || 0;

    if (lower === 'more' || lower === 'مزید') {
      page++;
      session.pending.page = page;
      session.markModified('pending');
      await session.save();
      const props = await Property.find({ _id: { $in: results } }).sort({ isFeatured: -1, createdAt: -1 });
      await safeSend(client, msg.from, formatPropertyList(props, lang, page));
      return;
    }

    const num = parseInt(lower);
    const startIdx = page * 5;
    const idx = startIdx + num - 1;

    if (!isNaN(num) && num >= 1 && idx < results.length) {
      const propId = results[idx];
      const prop   = await Property.findById(propId);
      if (!prop) {
        await safeSend(client, msg.from, lang === 'ur' ? '❌ پراپرٹی نہیں ملی۔' : '❌ Property not found.');
        return;
      }

      // Increment view count
      await Property.findByIdAndUpdate(propId, { $inc: { viewCount: 1 } });

      session.pending.selectedProp = propId;
      session.step = 'PROPERTY_DETAIL';
      session.markModified('pending');
      await session.save();

      // SEND IMAGE FIRST (if available)
      const imgUrl = prop.mainImage;
      if (imgUrl) {
        try {
          const media = await MessageMedia.fromUrl(imgUrl, { unsafeMime: true });
          await client.sendMessage(msg.from, media, { caption: prop.title });
        } catch (imgErr) {
          console.error('Image send failed:', imgErr.message);
          // Fallback: send text only
        }
      }

      // Send property detail text
      await safeSend(client, msg.from, formatPropertyDetail(prop, lang));
      return;
    }

    await safeSend(client, msg.from, lang === 'ur'
      ? '❗ درست نمبر لکھیں یا 0 لکھیں مینو کے لیے۔'
      : '❗ Please enter a valid number or 0 for menu.');
    return;
  }

  // ── PROPERTY DETAIL ──
  if (session.step === 'PROPERTY_DETAIL') {
    if (lower === '1' || lower === 'visit' || lower === 'وزٹ') {
      session.step = 'VISIT_NAME';
      session.markModified('pending');
      await session.save();
      await safeSend(client, msg.from, getVisitQuestion('name', lang));
      return;
    }
    if (lower === '2' || lower === 'agent' || lower === 'ایجنٹ') {
      const agents = await Agent.find({ agencyId, isActive: true }).limit(3);
      if (agents.length === 0) {
        const agency = await Agency.findById(agencyId);
        await safeSend(client, msg.from, lang === 'ur'
          ? `📞 ہم سے رابطہ کریں:\n${agency.phone}\n\n0 - مین مینو`
          : `📞 Contact us at:\n${agency.phone}\n\n0 - Main Menu`);
      } else {
        const lines = agents.map(a => `👤 *${a.name}*\n   📱 ${a.phone}${a.title ? '\n   🏷 ' + a.title : ''}`).join('\n\n');
        await safeSend(client, msg.from, (lang === 'ur'
          ? `📋 *ہمارے ایجنٹس:*\n\n${lines}\n\n0 - مین مینو`
          : `📋 *Our Agents:*\n\n${lines}\n\n0 - Main Menu`));
      }
      return;
    }
    if (lower === '3' || lower === 'back' || lower === 'واپس') {
      session.step = 'RESULTS';
      session.markModified('pending');
      await session.save();
      const results = session.pending.results || [];
      const page    = session.pending.page    || 0;
      const props   = await Property.find({ _id: { $in: results } });
      await safeSend(client, msg.from, formatPropertyList(props, lang, page));
      return;
    }
    // Re-show detail
    const prop = await Property.findById(session.pending.selectedProp);
    if (prop) await safeSend(client, msg.from, formatPropertyDetail(prop, lang));
    return;
  }

  // ── VISIT BOOKING ──
  if (session.step === 'VISIT_NAME') {
    session.pending.visitName = body;
    session.step = 'VISIT_PHONE';
    session.markModified('pending');
    await session.save();
    await safeSend(client, msg.from, getVisitQuestion('phone', lang));
    return;
  }

  if (session.step === 'VISIT_PHONE') {
    session.pending.visitPhone = body;
    session.step = 'VISIT_DATE';
    session.markModified('pending');
    await session.save();
    await safeSend(client, msg.from, getVisitQuestion('date', lang));
    return;
  }

  if (session.step === 'VISIT_DATE') {
    const { visitName, visitPhone, visitDate, selectedProp } = {
      ...session.pending,
      visitDate: body
    };

    const token = generateToken();

    // Create/Update Lead
    let lead = await Lead.findOne({ agencyId, phone: rawPhone });
    if (lead) {
      lead.name       = visitName || lead.name;
      lead.propertyId = selectedProp || lead.propertyId;
      lead.status     = lead.status === 'new' ? 'contacted' : lead.status;
      lead.updatedAt  = new Date();
      await lead.save();
    } else {
      lead = await Lead.create({
        agencyId,
        phone:      rawPhone,
        name:       visitName,
        propertyId: selectedProp,
        type:       session.pending.type || 'buy',
        budget:     session.pending.budgetText,
        area:       session.pending.area,
        source:     'whatsapp'
      });
    }

    // Create Meeting
    const meeting = await Meeting.create({
      agencyId,
      propertyId:  selectedProp,
      leadId:      lead._id,
      clientName:  visitName,
      clientPhone: visitPhone,
      date:        body,
      token,
      status:      'scheduled'
    });

    session.step = 'MENU';
    session.pending = {};
    session.markModified('pending');
    await session.save();

    await safeSend(client, msg.from, formatVisitReceipt(meeting, lang));
    return;
  }

  // ── SELL FLOW ──
  if (session.step === 'SELL_TYPE') {
    const typeMap = { '1': 'house', '2': 'apartment', '3': 'plot', '4': 'shop', '5': 'office', '6': 'other' };
    session.pending.sellType = typeMap[lower] || body;
    session.step = 'SELL_AREA';
    session.markModified('pending');
    await session.save();
    await safeSend(client, msg.from, getSellQuestion('area', lang));
    return;
  }

  if (session.step === 'SELL_AREA') {
    session.pending.sellArea = body;
    session.step = 'SELL_LOCATION';
    session.markModified('pending');
    await session.save();
    await safeSend(client, msg.from, getSellQuestion('location', lang));
    return;
  }

  if (session.step === 'SELL_LOCATION') {
    session.pending.sellLocation = body;
    session.step = 'SELL_PRICE';
    session.markModified('pending');
    await session.save();
    await safeSend(client, msg.from, getSellQuestion('price', lang));
    return;
  }

  if (session.step === 'SELL_PRICE') {
    session.pending.sellPrice = body;
    session.step = 'SELL_CNAME';
    session.markModified('pending');
    await session.save();
    await safeSend(client, msg.from, getSellQuestion('contactName', lang));
    return;
  }

  if (session.step === 'SELL_CNAME') {
    session.pending.sellCName = body;
    session.step = 'SELL_CPHONE';
    session.markModified('pending');
    await session.save();
    await safeSend(client, msg.from, getSellQuestion('contactPhone', lang));
    return;
  }

  if (session.step === 'SELL_CPHONE') {
    const { sellType, sellArea, sellLocation, sellPrice, sellCName } = session.pending;
    const description = `Type: ${sellType}\nArea: ${sellArea}\nLocation: ${sellLocation}\nPrice: ${sellPrice}`;

    await Lead.create({
      agencyId,
      phone:   rawPhone,
      name:    sellCName,
      message: description,
      type:    'sell',
      budget:  sellPrice,
      area:    sellArea,
      source:  'whatsapp'
    });

    session.step = 'MENU';
    session.pending = {};
    session.markModified('pending');
    await session.save();

    await safeSend(client, msg.from, lang === 'ur'
      ? `✅ *آپ کی پراپرٹی رجسٹر ہو گئی!*\n\n` +
        `🏠 قسم: ${sellType}\n📐 رقبہ: ${sellArea}\n📍 مقام: ${sellLocation}\n💰 قیمت: ${sellPrice}\n\n` +
        `ہمارا ایجنٹ جلد آپ سے رابطہ کرے گا۔\n\n0 - مین مینو`
      : `✅ *Property Listing Received!*\n\n` +
        `🏠 Type: ${sellType}\n📐 Area: ${sellArea}\n📍 Location: ${sellLocation}\n💰 Price: ${sellPrice}\n\n` +
        `Our agent will contact you shortly.\n\n0 - Main Menu`);
    return;
  }

  // ── FALLBACK ──
  session.step = 'MENU';
  session.pending = {};
  session.markModified('pending');
  await session.save();
  await safeSend(client, msg.from, formatMainMenu(agency.name, lang));
}

// ──────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────
function parseMenuChoice(lower) {
  if (/^(1|buy|خریدنا|buy|purchase)/.test(lower))       return 'buy';
  if (/^(2|rent|کرایہ|rental)/.test(lower))             return 'rent';
  if (/^(3|commercial|کمرشل|shop|office)/.test(lower))  return 'commercial';
  if (/^(4|sell|بیچنا|list)/.test(lower))               return 'sell';
  if (/^(5|faq|help|سوال|question)/.test(lower))        return 'faq';
  return null;
}

async function safeSend(client, to, text) {
  try {
    await client.sendMessage(to, text);
    const agencyId = [...clients.entries()].find(([, c]) => c === client)?.[0];
    if (agencyId) {
      const phone = to.replace('@c.us', '');
      await MessageLog.create({ agencyId, phone, direction: 'out', body: text, type: 'text' });
    }
  } catch (err) {
    console.error('Send error:', err.message);
  }
}

// ──────────────────────────────────────────────
// AUTO-START ALL ACTIVE AGENCY SESSIONS
// ──────────────────────────────────────────────
async function startAllSessions() {
  try {
    const agencies = await Agency.find({ isActive: true });
    console.log(`Starting ${agencies.length} WhatsApp sessions...`);
    for (const agency of agencies) {
      try {
        await initClient(agency);
      } catch (err) {
        console.error(`Failed to init client for ${agency.name}:`, err.message);
        statuses.set(agency._id.toString(), 'error');
      }
    }
  } catch (err) {
    console.error('startAllSessions error:', err.message);
  }
}

module.exports = { clients, qrCodes, statuses, initClient, startAllSessions };
