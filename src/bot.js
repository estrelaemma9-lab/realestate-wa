'use strict';

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');
const { Agency, Agent, Property, Lead, Meeting, FAQ, Session, MessageLog } = require('./models');
const {
  detectLang, isGreeting, matchFAQ,
  formatPropertyList, formatPropertyDetail, formatMainMenu,
  formatVisitReceipt, generateToken, getSellQuestion, getVisitQuestion, parseBudget
} = require('./utils/engine');

// ──────────────────────────────────────────────
// CHROME PATH DETECTION
// ──────────────────────────────────────────────
function getChromePath() {
  // If env variable set — use it
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
   // ignore env path — use auto detect
  }
  // Check common paths
  const paths = [
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/snap/bin/chromium',
    '/run/current-system/sw/bin/chromium',
    '/nix/var/nix/profiles/default/bin/chromium'
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      console.log('Chrome found at:', p);
      return p;
    }
  }
  console.log('Chrome not found — using default');
  return undefined;
}

// ──────────────────────────────────────────────
// GLOBAL SESSION STORES
// ──────────────────────────────────────────────
const clients  = new Map();
const qrCodes  = new Map();
const statuses = new Map();

// ──────────────────────────────────────────────
// INITIALIZE CLIENT
// ──────────────────────────────────────────────
async function initClient(agency) {
  const agencyId = agency._id.toString();

  if (clients.has(agencyId)) {
    try { await clients.get(agencyId).destroy(); } catch (_) {}
    clients.delete(agencyId);
  }

  statuses.set(agencyId, 'initializing');
  qrCodes.delete(agencyId);

  const chromePath = getChromePath();

  const puppeteerConfig = {
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
  };

  // Only set executablePath if found
  if (chromePath) puppeteerConfig.executablePath = chromePath;

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: agencyId }),
    puppeteer: puppeteerConfig
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
  if (msg.isGroupMsg) return;
  if (!msg.body && msg.type !== 'chat') return;

  const rawPhone = msg.from.replace('@c.us', '');
  const body     = (msg.body || '').trim();
  const agencyId = agency._id;

  try {
    await MessageLog.create({ agencyId, phone: rawPhone, direction: 'in', body, type: msg.type });
    await Agency.findByIdAndUpdate(agencyId, { $inc: { messageCount: 1 } });
  } catch (_) {}

  let session = await Session.findOne({ agencyId, phone: rawPhone });
  if (!session) session = await Session.create({ agencyId, phone: rawPhone });

  const lang = detectLang(body) || session.lang || 'en';
  session.lang = lang;
  session.lastActive = new Date();

  try {
    await processMessage(client, msg, agency, session, body, rawPhone, lang);
  } catch (err) {
    console.error(`[${agency.name}] Error:`, err.message);
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

  if (lower === '0' || lower === 'menu' || lower === 'مینو') {
    session.step = 'MENU'; session.pending = {};
    session.markModified('pending'); await session.save();
    await safeSend(client, msg.from, formatMainMenu(agency.name, lang));
    return;
  }

  const collectingSteps = ['VISIT_NAME','VISIT_PHONE','VISIT_DATE','SELL_TYPE','SELL_AREA','SELL_LOCATION','SELL_PRICE','SELL_CNAME','SELL_CPHONE'];
  if (!collectingSteps.includes(session.step)) {
    const faqs = await FAQ.find({ agencyId, isActive: true });
    const faqMatch = matchFAQ(body, faqs);
    if (faqMatch) {
      await FAQ.findByIdAndUpdate(faqMatch._id, { $inc: { hitCount: 1 } });
      await safeSend(client, msg.from, `❓ *${faqMatch.question}*\n\n${faqMatch.answer}\n\n_0 - ${lang === 'ur' ? 'مین مینو' : 'Main Menu'}_`);
      await session.save(); return;
    }
  }

  if (session.step === 'START' || isGreeting(body)) {
    session.step = 'MENU'; session.pending = {};
    session.markModified('pending'); await session.save();
    await safeSend(client, msg.from, formatMainMenu(agency.name, lang));
    return;
  }

  if (session.step === 'MENU') {
    const choice = parseMenuChoice(lower);
    if (choice === 'buy' || choice === 'rent' || choice === 'commercial') {
      session.step = 'ASK_BUDGET'; session.pending = { type: choice };
      session.markModified('pending'); await session.save();
      await safeSend(client, msg.from, lang === 'ur'
        ? `💰 آپ کا بجٹ کتنا ہے؟\n(مثلاً: 50 لاکھ، 1 کروڑ، یا "کوئی بھی")`
        : `💰 What is your budget?\n(e.g. 50 Lakh, 1 Crore, or "any")`);
      return;
    }
    if (choice === 'sell') {
      session.step = 'SELL_TYPE'; session.pending = {};
      session.markModified('pending'); await session.save();
      await safeSend(client, msg.from, getSellQuestion('propertyType', lang));
      return;
    }
    if (choice === 'faq') {
      const faqs = await FAQ.find({ agencyId, isActive: true }).limit(5);
      if (!faqs.length) {
        await safeSend(client, msg.from, lang === 'ur' ? '📖 ابھی کوئی سوال نہیں ہے۔\n\n0 - مین مینو' : '📖 No FAQs yet.\n\n0 - Main Menu');
      } else {
        const lines = faqs.map((f, i) => `${i+1}. ${f.question}`).join('\n');
        await safeSend(client, msg.from, lang === 'ur'
          ? `❓ *اکثر پوچھے گئے سوالات:*\n\n${lines}\n\nنمبر لکھیں\n0 - مین مینو`
          : `❓ *FAQs:*\n\n${lines}\n\nReply with number\n0 - Main Menu`);
        session.step = 'FAQ_LIST';
        session.pending = { faqs: faqs.map(f => f._id.toString()) };
        session.markModified('pending');
      }
      await session.save(); return;
    }
    await safeSend(client, msg.from, formatMainMenu(agency.name, lang));
    return;
  }

  if (session.step === 'FAQ_LIST') {
    const faqIds = (session.pending && session.pending.faqs) || [];
    const num = parseInt(lower);
    if (!isNaN(num) && num >= 1 && num <= faqIds.length) {
      const faq = await FAQ.findById(faqIds[num-1]);
      if (faq) {
        await FAQ.findByIdAndUpdate(faq._id, { $inc: { hitCount: 1 } });
        await safeSend(client, msg.from, `❓ *${faq.question}*\n\n${faq.answer}\n\n0 - ${lang==='ur'?'مین مینو':'Main Menu'}`);
      }
    } else {
      session.step = 'MENU';
      await safeSend(client, msg.from, formatMainMenu(agency.name, lang));
    }
    await session.save(); return;
  }

  if (session.step === 'ASK_BUDGET') {
    session.pending.budget = (lower !== 'any' && lower !== 'کوئی بھی') ? parseBudget(body) : null;
    session.pending.budgetText = body;
    session.step = 'ASK_AREA';
    session.markModified('pending'); await session.save();
    await safeSend(client, msg.from, lang === 'ur'
      ? `📍 کس علاقے میں پراپرٹی چاہیے؟\n(یا "کوئی بھی" لکھیں)`
      : `📍 Which area?\n(or type "any")`);
    return;
  }

  if (session.step === 'ASK_AREA') {
    const area = (lower === 'any' || lower === 'کوئی بھی') ? null : body;
    session.pending.area = area;
    session.markModified('pending'); await session.save();

    const query = { agencyId, type: session.pending.type, isActive: true, isSold: false };
    if (session.pending.budget) query.price = { $lte: session.pending.budget };
    if (area) query.$or = [
      { city: { $regex: area, $options: 'i' } },
      { location: { $regex: area, $options: 'i' } },
      { address: { $regex: area, $options: 'i' } }
    ];

    const props = await Property.find(query).sort({ isFeatured: -1, createdAt: -1 }).limit(20);
    session.pending.results = props.map(p => p._id.toString());
    session.pending.page = 0;
    session.step = 'RESULTS';
    session.markModified('pending'); await session.save();
    await safeSend(client, msg.from, formatPropertyList(props, lang, 0));
    return;
  }

  if (session.step === 'RESULTS') {
    const results = session.pending.results || [];
    let page = session.pending.page || 0;

    if (lower === 'more' || lower === 'مزید') {
      page++;
      session.pending.page = page;
      session.markModified('pending'); await session.save();
      const props = await Property.find({ _id: { $in: results } }).sort({ isFeatured: -1, createdAt: -1 });
      await safeSend(client, msg.from, formatPropertyList(props, lang, page));
      return;
    }

    const num = parseInt(lower);
    const idx = (page * 5) + num - 1;

    if (!isNaN(num) && num >= 1 && idx < results.length) {
      const prop = await Property.findById(results[idx]);
      if (!prop) { await safeSend(client, msg.from, '❌ Not found.'); return; }
      await Property.findByIdAndUpdate(results[idx], { $inc: { viewCount: 1 } });
      session.pending.selectedProp = results[idx];
      session.step = 'PROPERTY_DETAIL';
      session.markModified('pending'); await session.save();

      if (prop.mainImage) {
        try {
          const media = await MessageMedia.fromUrl(prop.mainImage, { unsafeMime: true });
          await client.sendMessage(msg.from, media, { caption: prop.title });
        } catch (_) {}
      }
      await safeSend(client, msg.from, formatPropertyDetail(prop, lang));
      return;
    }
    await safeSend(client, msg.from, lang === 'ur' ? '❗ درست نمبر لکھیں یا 0 مینو کے لیے' : '❗ Enter valid number or 0 for menu.');
    return;
  }

  if (session.step === 'PROPERTY_DETAIL') {
    if (lower === '1' || lower === 'visit' || lower === 'وزٹ') {
      session.step = 'VISIT_NAME'; session.markModified('pending'); await session.save();
      await safeSend(client, msg.from, getVisitQuestion('name', lang)); return;
    }
    if (lower === '2' || lower === 'agent' || lower === 'ایجنٹ') {
      const agents = await Agent.find({ agencyId, isActive: true }).limit(3);
      if (!agents.length) {
        const ag = await Agency.findById(agencyId);
        await safeSend(client, msg.from, lang === 'ur' ? `📞 رابطہ کریں:\n${ag.phone}\n\n0 - مین مینو` : `📞 Contact:\n${ag.phone}\n\n0 - Main Menu`);
      } else {
        const lines = agents.map(a => `👤 *${a.name}*\n   📱 ${a.phone}`).join('\n\n');
        await safeSend(client, msg.from, lang === 'ur' ? `📋 *ایجنٹس:*\n\n${lines}\n\n0 - مین مینو` : `📋 *Agents:*\n\n${lines}\n\n0 - Main Menu`);
      }
      return;
    }
    if (lower === '3' || lower === 'back' || lower === 'واپس') {
      session.step = 'RESULTS'; session.markModified('pending'); await session.save();
      const props = await Property.find({ _id: { $in: session.pending.results || [] } });
      await safeSend(client, msg.from, formatPropertyList(props, lang, session.pending.page || 0));
      return;
    }
    const prop = await Property.findById(session.pending.selectedProp);
    if (prop) await safeSend(client, msg.from, formatPropertyDetail(prop, lang));
    return;
  }

  if (session.step === 'VISIT_NAME') {
    session.pending.visitName = body; session.step = 'VISIT_PHONE';
    session.markModified('pending'); await session.save();
    await safeSend(client, msg.from, getVisitQuestion('phone', lang)); return;
  }

  if (session.step === 'VISIT_PHONE') {
    session.pending.visitPhone = body; session.step = 'VISIT_DATE';
    session.markModified('pending'); await session.save();
    await safeSend(client, msg.from, getVisitQuestion('date', lang)); return;
  }

  if (session.step === 'VISIT_DATE') {
    const { visitName, visitPhone, selectedProp } = session.pending;
    const token = generateToken();

    let lead = await Lead.findOne({ agencyId, phone: rawPhone });
    if (lead) {
      lead.name = visitName || lead.name;
      lead.propertyId = selectedProp || lead.propertyId;
      lead.status = lead.status === 'new' ? 'contacted' : lead.status;
      lead.updatedAt = new Date(); await lead.save();
    } else {
      lead = await Lead.create({ agencyId, phone: rawPhone, name: visitName, propertyId: selectedProp, type: session.pending.type || 'buy', budget: session.pending.budgetText, area: session.pending.area, source: 'whatsapp' });
    }

    const meeting = await Meeting.create({ agencyId, propertyId: selectedProp, leadId: lead._id, clientName: visitName, clientPhone: visitPhone, date: body, token, status: 'scheduled' });

    session.step = 'MENU'; session.pending = {};
    session.markModified('pending'); await session.save();
    await safeSend(client, msg.from, formatVisitReceipt(meeting, lang));
    return;
  }

  if (session.step === 'SELL_TYPE') {
    const typeMap = { '1':'house','2':'apartment','3':'plot','4':'shop','5':'office','6':'other' };
    session.pending.sellType = typeMap[lower] || body; session.step = 'SELL_AREA';
    session.markModified('pending'); await session.save();
    await safeSend(client, msg.from, getSellQuestion('area', lang)); return;
  }

  if (session.step === 'SELL_AREA') {
    session.pending.sellArea = body; session.step = 'SELL_LOCATION';
    session.markModified('pending'); await session.save();
    await safeSend(client, msg.from, getSellQuestion('location', lang)); return;
  }

  if (session.step === 'SELL_LOCATION') {
    session.pending.sellLocation = body; session.step = 'SELL_PRICE';
    session.markModified('pending'); await session.save();
    await safeSend(client, msg.from, getSellQuestion('price', lang)); return;
  }

  if (session.step === 'SELL_PRICE') {
    session.pending.sellPrice = body; session.step = 'SELL_CNAME';
    session.markModified('pending'); await session.save();
    await safeSend(client, msg.from, getSellQuestion('contactName', lang)); return;
  }

  if (session.step === 'SELL_CNAME') {
    session.pending.sellCName = body; session.step = 'SELL_CPHONE';
    session.markModified('pending'); await session.save();
    await safeSend(client, msg.from, getSellQuestion('contactPhone', lang)); return;
  }

  if (session.step === 'SELL_CPHONE') {
    const { sellType, sellArea, sellLocation, sellPrice, sellCName } = session.pending;
    await Lead.create({ agencyId, phone: rawPhone, name: sellCName, message: `Type: ${sellType}\nArea: ${sellArea}\nLocation: ${sellLocation}\nPrice: ${sellPrice}`, type: 'sell', budget: sellPrice, area: sellArea, source: 'whatsapp' });
    session.step = 'MENU'; session.pending = {};
    session.markModified('pending'); await session.save();
    await safeSend(client, msg.from, lang === 'ur'
      ? `✅ *پراپرٹی رجسٹر ہو گئی!*\n\n🏠 ${sellType}\n📐 ${sellArea}\n📍 ${sellLocation}\n💰 ${sellPrice}\n\nایجنٹ رابطہ کرے گا۔\n\n0 - مین مینو`
      : `✅ *Listing Received!*\n\n🏠 ${sellType}\n📐 ${sellArea}\n📍 ${sellLocation}\n💰 ${sellPrice}\n\nAgent will contact you.\n\n0 - Main Menu`);
    return;
  }

  session.step = 'MENU'; session.pending = {};
  session.markModified('pending'); await session.save();
  await safeSend(client, msg.from, formatMainMenu(agency.name, lang));
}

// ──────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────
function parseMenuChoice(lower) {
  if (/^(1|buy|خریدنا|purchase)/.test(lower))          return 'buy';
  if (/^(2|rent|کرایہ|rental)/.test(lower))            return 'rent';
  if (/^(3|commercial|کمرشل|shop|office)/.test(lower)) return 'commercial';
  if (/^(4|sell|بیچنا|list)/.test(lower))              return 'sell';
  if (/^(5|faq|help|سوال|question)/.test(lower))       return 'faq';
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
  } catch (err) { console.error('Send error:', err.message); }
}

async function startAllSessions() {
  try {
    const agencies = await Agency.find({ isActive: true });
    console.log(`Starting ${agencies.length} WhatsApp sessions...`);
    for (const agency of agencies) {
      try { await initClient(agency); } catch (err) {
        console.error(`Failed to init client for ${agency.name}:`, err.message);
        statuses.set(agency._id.toString(), 'error');
      }
    }
  } catch (err) { console.error('startAllSessions error:', err.message); }
}

module.exports = { clients, qrCodes, statuses, initClient, startAllSessions };
