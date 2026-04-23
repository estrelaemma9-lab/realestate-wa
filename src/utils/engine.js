'use strict';

// ──────────────────────────────────────────────
// LANGUAGE DETECTION
// ──────────────────────────────────────────────
function detectLang(text) {
  // Urdu Unicode range: 0600–06FF, FB50–FDFF, FE70–FEFF
  const urduPattern = /[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
  return urduPattern.test(text) ? 'ur' : 'en';
}

// ──────────────────────────────────────────────
// GREETING DETECTION
// ──────────────────────────────────────────────
function isGreeting(text) {
  const lower = text.toLowerCase().trim();
  const patterns = [
    /^(hi|hello|hey|helo|hii|hiii)(\s|$)/i,
    /^(salam|salaam|assalam|aoa|asslam|aslam|assalamualaikum)/i,
    /^(start|menu|home|help|مدد|شروع)/i,
    /^(good\s*(morning|evening|afternoon|night))/i,
    /^(السلام|وعلیکم|ہیلو|ہائے)/i
  ];
  return patterns.some(p => p.test(lower));
}

// ──────────────────────────────────────────────
// FAQ KEYWORD MATCHING ENGINE
// ──────────────────────────────────────────────
function matchFAQ(text, faqs) {
  if (!faqs || faqs.length === 0) return null;
  const lower = text.toLowerCase().trim();
  let bestMatch = null;
  let bestScore = 0;

  for (const faq of faqs) {
    if (!faq.isActive) continue;
    let score = 0;

    // Direct question substring match
    if (lower.includes(faq.question.toLowerCase())) score += 10;

    // Keyword matching
    if (faq.keywords && faq.keywords.length > 0) {
      for (const kw of faq.keywords) {
        const kwl = kw.toLowerCase().trim();
        if (!kwl) continue;
        if (lower === kwl) score += 8;
        else if (lower.includes(kwl)) score += 4;
        else if (kwl.includes(lower)) score += 2;
        // Partial word matching
        const words = lower.split(/\s+/);
        for (const w of words) {
          if (w.length > 2 && kwl.includes(w)) score += 1;
        }
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = faq;
    }
  }

  return bestScore >= 3 ? bestMatch : null;
}

// ──────────────────────────────────────────────
// PROPERTY FORMATTERS
// ──────────────────────────────────────────────
function formatPrice(price, unit = 'PKR') {
  if (!price) return 'N/A';
  if (price >= 10000000) return `${(price / 10000000).toFixed(2)} Crore ${unit}`;
  if (price >= 100000)   return `${(price / 100000).toFixed(2)} Lakh ${unit}`;
  return `${price.toLocaleString()} ${unit}`;
}

function formatPropertyList(properties, lang = 'en', page = 0) {
  if (!properties || properties.length === 0) {
    return lang === 'ur'
      ? '😔 آپ کی تلاش کے مطابق کوئی پراپرٹی نہیں ملی۔\n\nدوبارہ تلاش کریں:\n1️⃣ بجٹ تبدیل کریں\n2️⃣ علاقہ تبدیل کریں\n0️⃣ مین مینو'
      : '😔 No properties found matching your criteria.\n\nTry:\n1️⃣ Change budget\n2️⃣ Change area\n0️⃣ Main Menu';
  }

  const start = page * 5;
  const slice = properties.slice(start, start + 5);
  const header = lang === 'ur'
    ? `🏠 *دستیاب پراپرٹیز* (${start + 1}-${start + slice.length} از ${properties.length})\n\n`
    : `🏠 *Available Properties* (${start + 1}-${start + slice.length} of ${properties.length})\n\n`;

  const lines = slice.map((p, i) => {
    const idx = start + i + 1;
    const price = formatPrice(p.price, p.priceUnit);
    const area  = p.area ? `${p.area} ${p.areaUnit}` : '';
    const beds  = p.bedrooms > 0 ? `🛏 ${p.bedrooms}` : '';
    const baths = p.bathrooms > 0 ? `🚿 ${p.bathrooms}` : '';
    const loc   = p.city || p.location || '';
    return `*${idx}.* ${p.title}\n    💰 ${price}${area ? ' | 📐 ' + area : ''}${beds ? ' | ' + beds : ''}${baths ? ' | ' + baths : ''}\n    📍 ${loc}`;
  });

  let footer = `\n\n_${lang === 'ur' ? 'نمبر لکھیں تفصیل دیکھنے کے لیے' : 'Reply with number to see details'}_`;
  if (properties.length > start + 5) {
    footer += `\n_${lang === 'ur' ? '"مزید" لکھیں اگلی فہرست کے لیے' : 'Reply "more" for next page'}_`;
  }
  footer += `\n_0 - ${lang === 'ur' ? 'مین مینو' : 'Main Menu'}_`;

  return header + lines.join('\n\n') + footer;
}

function formatPropertyDetail(p, lang = 'en') {
  const price = formatPrice(p.price, p.priceUnit);
  const area  = p.area ? `${p.area} ${p.areaUnit}` : 'N/A';
  const typeLabel = { buy: 'For Sale', rent: 'For Rent', commercial: 'Commercial' };

  if (lang === 'ur') {
    return `🏠 *${p.title}*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🏷 قسم: ${typeLabel[p.type] || p.type}\n` +
      `💰 قیمت: ${price}${p.priceLabel ? ' ' + p.priceLabel : ''}\n` +
      `📐 رقبہ: ${area}\n` +
      (p.bedrooms  ? `🛏 کمرے: ${p.bedrooms}\n`  : '') +
      (p.bathrooms ? `🚿 باتھ: ${p.bathrooms}\n` : '') +
      (p.address   ? `📍 پتہ: ${p.address}\n`    : '') +
      (p.city      ? `🌆 شہر: ${p.city}\n`        : '') +
      (p.description ? `\n📝 تفصیل:\n${p.description}\n` : '') +
      (p.features && p.features.length > 0 ? `\n✨ خصوصیات:\n${p.features.map(f => `• ${f}`).join('\n')}\n` : '') +
      `\n━━━━━━━━━━━━━━━━━━\n` +
      `جواب دیں:\n` +
      `1 - وزٹ بک کریں\n` +
      `2 - ایجنٹ سے بات کریں\n` +
      `3 - واپس جائیں\n` +
      `0 - مین مینو`;
  }

  return `🏠 *${p.title}*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🏷 Type: ${typeLabel[p.type] || p.type}\n` +
    `💰 Price: ${price}${p.priceLabel ? ' ' + p.priceLabel : ''}\n` +
    `📐 Area: ${area}\n` +
    (p.bedrooms  ? `🛏 Bedrooms: ${p.bedrooms}\n`  : '') +
    (p.bathrooms ? `🚿 Bathrooms: ${p.bathrooms}\n` : '') +
    (p.address   ? `📍 Address: ${p.address}\n`     : '') +
    (p.city      ? `🌆 City: ${p.city}\n`            : '') +
    (p.description ? `\n📝 Description:\n${p.description}\n` : '') +
    (p.features && p.features.length > 0 ? `\n✨ Features:\n${p.features.map(f => `• ${f}`).join('\n')}\n` : '') +
    `\n━━━━━━━━━━━━━━━━━━\n` +
    `Reply:\n` +
    `1 - Book a Visit\n` +
    `2 - Talk to Agent\n` +
    `3 - Go Back\n` +
    `0 - Main Menu`;
}

function formatMainMenu(agencyName = 'Us', lang = 'en') {
  if (lang === 'ur') {
    return `🏢 *${agencyName}* میں خوش آمدید!\n\n` +
      `آپ کیا چاہتے ہیں؟\n\n` +
      `1️⃣ *خریدنا ہے* - پراپرٹی خریدیں\n` +
      `2️⃣ *کرایہ پر لینا ہے* - کرایہ کی پراپرٹی\n` +
      `3️⃣ *کمرشل* - دکان / دفتر\n` +
      `4️⃣ *بیچنا ہے* - اپنی پراپرٹی بیچیں\n` +
      `5️⃣ *سوالات* - عام سوالات\n\n` +
      `_نمبر لکھیں یا آپشن کا نام_`;
  }
  return `🏢 *Welcome to ${agencyName}!*\n\n` +
    `How can we help you today?\n\n` +
    `1️⃣ *Buy* - Looking to buy a property\n` +
    `2️⃣ *Rent* - Looking to rent a property\n` +
    `3️⃣ *Commercial* - Shop / Office space\n` +
    `4️⃣ *Sell* - List your property\n` +
    `5️⃣ *FAQ* - Common questions\n\n` +
    `_Reply with a number or option name_`;
}

function formatVisitReceipt(meeting, lang = 'en') {
  if (lang === 'ur') {
    return `✅ *وزٹ بک ہو گئی!*\n\n` +
      `🎟 ٹوکن نمبر: *${meeting.token}*\n` +
      `👤 نام: ${meeting.clientName}\n` +
      `📱 فون: ${meeting.clientPhone}\n` +
      `📅 تاریخ: ${meeting.date}\n` +
      `📌 حالت: تصدیق شدہ\n\n` +
      `ہمارا ایجنٹ جلد آپ سے رابطہ کرے گا۔\n\n` +
      `0 - مین مینو`;
  }
  return `✅ *Visit Booked Successfully!*\n\n` +
    `🎟 Token: *${meeting.token}*\n` +
    `👤 Name: ${meeting.clientName}\n` +
    `📱 Phone: ${meeting.clientPhone}\n` +
    `📅 Date: ${meeting.date}\n` +
    `📌 Status: Confirmed\n\n` +
    `Our agent will contact you shortly.\n\n` +
    `0 - Main Menu`;
}

function generateToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let token = 'RE-';
  for (let i = 0; i < 6; i++) token += chars[Math.floor(Math.random() * chars.length)];
  return token;
}

// ──────────────────────────────────────────────
// SELL FLOW QUESTIONS
// ──────────────────────────────────────────────
function getSellQuestion(field, lang = 'en') {
  const q = {
    propertyType: {
      en: '🏘 What type of property are you selling?\n\n1 - House\n2 - Apartment\n3 - Plot\n4 - Shop\n5 - Office\n6 - Other',
      ur: '🏘 آپ کس قسم کی پراپرٹی بیچنا چاہتے ہیں؟\n\n1 - مکان\n2 - اپارٹمنٹ\n3 - پلاٹ\n4 - دکان\n5 - دفتر\n6 - دیگر'
    },
    area: {
      en: '📐 What is the area/size? (e.g. 5 Marla, 1 Kanal, 200 sq ft)',
      ur: '📐 رقبہ کتنا ہے؟ (مثلاً 5 مرلہ، 1 کنال)'
    },
    location: {
      en: '📍 What is the location / address?',
      ur: '📍 پراپرٹی کا پتہ یا علاقہ بتائیں؟'
    },
    price: {
      en: '💰 What is your expected price? (e.g. 50 Lakh, 1 Crore)',
      ur: '💰 آپ کی متوقع قیمت کیا ہے؟ (مثلاً 50 لاکھ، 1 کروڑ)'
    },
    contactName: {
      en: '👤 Please enter your full name:',
      ur: '👤 اپنا پورا نام لکھیں:'
    },
    contactPhone: {
      en: '📱 Please enter your WhatsApp number:',
      ur: '📱 اپنا واٹس ایپ نمبر لکھیں:'
    }
  };
  return (q[field] && q[field][lang]) || q[field]?.en || '';
}

// ──────────────────────────────────────────────
// VISIT BOOKING QUESTIONS
// ──────────────────────────────────────────────
function getVisitQuestion(field, lang = 'en') {
  const q = {
    name: {
      en: '👤 Please enter your full name:',
      ur: '👤 اپنا پورا نام لکھیں:'
    },
    phone: {
      en: '📱 Please enter your contact number:',
      ur: '📱 اپنا رابطہ نمبر لکھیں:'
    },
    date: {
      en: '📅 What date would you like to visit? (e.g. tomorrow, Jan 25, 25/1/2025)',
      ur: '📅 کس تاریخ کو وزٹ کرنا چاہتے ہیں؟ (مثلاً کل، 25 جنوری)'
    }
  };
  return (q[field] && q[field][lang]) || q[field]?.en || '';
}

// ──────────────────────────────────────────────
// BUDGET NORMALIZATION
// ──────────────────────────────────────────────
function parseBudget(text) {
  const lower = text.toLowerCase().replace(/,/g, '');
  const croreMatch = lower.match(/(\d+(?:\.\d+)?)\s*(crore|کروڑ|cr)/);
  const lakhMatch  = lower.match(/(\d+(?:\.\d+)?)\s*(lakh|lac|لاکھ|l\b)/);
  const numMatch   = lower.match(/^(\d+(?:\.\d+)?)$/);

  if (croreMatch) return Math.floor(parseFloat(croreMatch[1]) * 10000000);
  if (lakhMatch)  return Math.floor(parseFloat(lakhMatch[1]) * 100000);
  if (numMatch)   return parseInt(numMatch[1]);
  return null;
}

module.exports = {
  detectLang,
  isGreeting,
  matchFAQ,
  formatPrice,
  formatPropertyList,
  formatPropertyDetail,
  formatMainMenu,
  formatVisitReceipt,
  generateToken,
  getSellQuestion,
  getVisitQuestion,
  parseBudget
};
