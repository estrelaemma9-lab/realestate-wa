'use strict';

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const bcrypt     = require('bcryptjs');
const mongoose   = require('mongoose');
const cloudinary = require('cloudinary').v2;
const multer     = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const { Agency, Agent, Property, Lead, Meeting, FAQ, Session, MessageLog } = require('./models');
const { clients, qrCodes, statuses, initClient, startAllSessions } = require('./bot');

// ──────────────────────────────────────────────
// APP SETUP
// ──────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// ──────────────────────────────────────────────
// CLOUDINARY SETUP
// ──────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder:         'realestateai',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 1200, height: 900, crop: 'limit', quality: 'auto' }]
  })
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files allowed'), false);
  }
});

// ──────────────────────────────────────────────
// MONGODB CONNECTION
// ──────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/realestateai', {
  useNewUrlParser:    true,
  useUnifiedTopology: true
}).then(() => {
  console.log('✅ MongoDB connected');
  startAllSessions();
}).catch(err => {
  console.error('❌ MongoDB error:', err.message);
});

// ──────────────────────────────────────────────
// AUTH MIDDLEWARE
// ──────────────────────────────────────────────
async function authMiddleware(req, res, next) {
  try {
    const phone = req.headers['x-agency-phone'];
    const pass  = req.headers['x-agency-pass'];
    if (!phone || !pass) return res.status(401).json({ ok: false, msg: 'Missing credentials' });

    const agency = await Agency.findOne({ phone });
    if (!agency) return res.status(401).json({ ok: false, msg: 'Agency not found' });

    const valid = await bcrypt.compare(pass, agency.password);
    if (!valid) return res.status(401).json({ ok: false, msg: 'Invalid password' });

    req.agency = agency;
    next();
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
}

// ──────────────────────────────────────────────
// ── AGENCY ROUTES ──
// ──────────────────────────────────────────────
const agencyRouter = express.Router();

// Register
agencyRouter.post('/register', async (req, res) => {
  try {
    const { name, phone, password, email, city, address } = req.body;
    if (!name || !phone || !password) return res.status(400).json({ ok: false, msg: 'name, phone, password required' });

    const exists = await Agency.findOne({ phone });
    if (exists) return res.status(409).json({ ok: false, msg: 'Phone already registered' });

    const hashed = await bcrypt.hash(password, 10);
    const agency = await Agency.create({ name, phone, password: hashed, email, city, address });
    res.json({ ok: true, agency: { _id: agency._id, name: agency.name, phone: agency.phone } });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// Login
agencyRouter.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const agency = await Agency.findOne({ phone });
    if (!agency) return res.status(401).json({ ok: false, msg: 'Agency not found' });

    const valid = await bcrypt.compare(password, agency.password);
    if (!valid) return res.status(401).json({ ok: false, msg: 'Invalid password' });

    res.json({ ok: true, agency: { _id: agency._id, name: agency.name, phone: agency.phone, city: agency.city, email: agency.email, currency: agency.currency, greetingMsg: agency.greetingMsg } });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// Get settings
agencyRouter.get('/settings', authMiddleware, async (req, res) => {
  try {
    const a = req.agency;
    res.json({ ok: true, agency: { _id: a._id, name: a.name, phone: a.phone, email: a.email, address: a.address, city: a.city, website: a.website, currency: a.currency, greetingMsg: a.greetingMsg, plan: a.plan, messageCount: a.messageCount } });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// Update settings
agencyRouter.put('/settings', authMiddleware, async (req, res) => {
  try {
    const { name, email, address, city, website, currency, greetingMsg } = req.body;
    const updated = await Agency.findByIdAndUpdate(
      req.agency._id,
      { name, email, address, city, website, currency, greetingMsg },
      { new: true, select: '-password' }
    );
    res.json({ ok: true, agency: updated });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// Change password
agencyRouter.put('/password', authMiddleware, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ ok: false, msg: 'Password too short' });
    const hashed = await bcrypt.hash(newPassword, 10);
    await Agency.findByIdAndUpdate(req.agency._id, { password: hashed });
    res.json({ ok: true, msg: 'Password updated' });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

app.use('/api/agency', agencyRouter);

// ──────────────────────────────────────────────
// ── WHATSAPP ROUTES ──
// ──────────────────────────────────────────────
const waRouter = express.Router();
waRouter.use(authMiddleware);

waRouter.get('/status', (req, res) => {
  const id     = req.agency._id.toString();
  const status = statuses.get(id) || 'not_started';
  const qr     = qrCodes.get(id)  || null;
  res.json({ ok: true, status, qr });
});

waRouter.post('/start', async (req, res) => {
  try {
    const agency = req.agency;
    const id     = agency._id.toString();
    const current = statuses.get(id);
    if (current === 'connected' || current === 'initializing') {
      return res.json({ ok: true, msg: `Already ${current}`, status: current });
    }
    initClient(agency).catch(err => {
      console.error('initClient error:', err.message);
      statuses.set(id, 'error');
    });
    res.json({ ok: true, msg: 'Session starting', status: 'initializing' });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

waRouter.post('/restart', async (req, res) => {
  try {
    const agency = req.agency;
    const id     = agency._id.toString();
    statuses.set(id, 'restarting');
    initClient(agency).catch(err => {
      console.error('restart error:', err.message);
      statuses.set(id, 'error');
    });
    res.json({ ok: true, msg: 'Restarting session' });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

app.use('/api/wa', waRouter);

// ──────────────────────────────────────────────
// ── PROPERTY ROUTES ──
// ──────────────────────────────────────────────
const propRouter = express.Router();
propRouter.use(authMiddleware);

// List
propRouter.get('/', async (req, res) => {
  try {
    const { type, isActive, isSold, search, page = 1, limit = 20 } = req.query;
    const query = { agencyId: req.agency._id };
    if (type)     query.type = type;
    if (isActive !== undefined) query.isActive = isActive === 'true';
    if (isSold   !== undefined) query.isSold   = isSold   === 'true';
    if (search) {
      query.$or = [
        { title:    { $regex: search, $options: 'i' } },
        { address:  { $regex: search, $options: 'i' } },
        { city:     { $regex: search, $options: 'i' } },
        { location: { $regex: search, $options: 'i' } }
      ];
    }
    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await Property.countDocuments(query);
    const props = await Property.find(query)
      .sort({ isFeatured: -1, createdAt: -1 })
      .skip(skip).limit(parseInt(limit))
      .populate('agentId', 'name phone');
    res.json({ ok: true, properties: props, total, page: parseInt(page) });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// Get single
propRouter.get('/:id', async (req, res) => {
  try {
    const prop = await Property.findOne({ _id: req.params.id, agencyId: req.agency._id })
      .populate('agentId', 'name phone email');
    if (!prop) return res.status(404).json({ ok: false, msg: 'Property not found' });
    res.json({ ok: true, property: prop });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// Create
propRouter.post('/', async (req, res) => {
  try {
    const { title, description, type, category, price, priceUnit, priceLabel, area, areaUnit, bedrooms, bathrooms, address, city, location, features, agentId, isFeatured } = req.body;
    if (!title || !type || price === undefined) return res.status(400).json({ ok: false, msg: 'title, type, price required' });
    const prop = await Property.create({
      agencyId: req.agency._id,
      title, description, type, category, price: parseFloat(price),
      priceUnit, priceLabel, area: area ? parseFloat(area) : undefined,
      areaUnit, bedrooms: parseInt(bedrooms) || 0, bathrooms: parseInt(bathrooms) || 0,
      address, city, location,
      features: Array.isArray(features) ? features : (features ? features.split(',').map(s => s.trim()) : []),
      agentId: agentId || undefined,
      isFeatured: isFeatured === 'true' || isFeatured === true
    });
    res.json({ ok: true, property: prop });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// Update
propRouter.put('/:id', async (req, res) => {
  try {
    const { title, description, type, category, price, priceUnit, priceLabel, area, areaUnit, bedrooms, bathrooms, address, city, location, features, agentId, isFeatured, isActive } = req.body;
    const update = {
      updatedAt: new Date(),
      ...(title       !== undefined && { title }),
      ...(description !== undefined && { description }),
      ...(type        !== undefined && { type }),
      ...(category    !== undefined && { category }),
      ...(price       !== undefined && { price: parseFloat(price) }),
      ...(priceUnit   !== undefined && { priceUnit }),
      ...(priceLabel  !== undefined && { priceLabel }),
      ...(area        !== undefined && { area: parseFloat(area) }),
      ...(areaUnit    !== undefined && { areaUnit }),
      ...(bedrooms    !== undefined && { bedrooms: parseInt(bedrooms) }),
      ...(bathrooms   !== undefined && { bathrooms: parseInt(bathrooms) }),
      ...(address     !== undefined && { address }),
      ...(city        !== undefined && { city }),
      ...(location    !== undefined && { location }),
      ...(agentId     !== undefined && { agentId: agentId || null }),
      ...(isFeatured  !== undefined && { isFeatured: isFeatured === 'true' || isFeatured === true }),
      ...(isActive    !== undefined && { isActive:   isActive   === 'true' || isActive   === true }),
      ...(features    !== undefined && { features: Array.isArray(features) ? features : features.split(',').map(s => s.trim()) })
    };
    const prop = await Property.findOneAndUpdate(
      { _id: req.params.id, agencyId: req.agency._id },
      update, { new: true }
    );
    if (!prop) return res.status(404).json({ ok: false, msg: 'Property not found' });
    res.json({ ok: true, property: prop });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// Mark sold
propRouter.patch('/:id/sold', async (req, res) => {
  try {
    const { isSold } = req.body;
    const prop = await Property.findOneAndUpdate(
      { _id: req.params.id, agencyId: req.agency._id },
      { isSold: !!isSold, updatedAt: new Date() },
      { new: true }
    );
    if (!prop) return res.status(404).json({ ok: false, msg: 'Not found' });
    res.json({ ok: true, property: prop });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// Delete
propRouter.delete('/:id', async (req, res) => {
  try {
    // Delete images from cloudinary
    const prop = await Property.findOne({ _id: req.params.id, agencyId: req.agency._id });
    if (!prop) return res.status(404).json({ ok: false, msg: 'Not found' });
    for (const img of prop.images) {
      try { await cloudinary.uploader.destroy(img.public_id); } catch (_) {}
    }
    await Property.deleteOne({ _id: req.params.id });
    res.json({ ok: true, msg: 'Deleted' });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// Upload images (max 5)
propRouter.post('/:id/images', upload.array('images', 5), async (req, res) => {
  try {
    const prop = await Property.findOne({ _id: req.params.id, agencyId: req.agency._id });
    if (!prop) return res.status(404).json({ ok: false, msg: 'Property not found' });
    if (!req.files || req.files.length === 0) return res.status(400).json({ ok: false, msg: 'No files uploaded' });

    const totalImages = prop.images.length + req.files.length;
    if (totalImages > 10) return res.status(400).json({ ok: false, msg: 'Max 10 images per property' });

    const hasMain = prop.images.some(i => i.isMain);
    for (let i = 0; i < req.files.length; i++) {
      const f = req.files[i];
      prop.images.push({
        url:       f.path,
        public_id: f.filename,
        isMain:    !hasMain && i === 0
      });
    }

    await prop.save();
    res.json({ ok: true, property: prop });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// Delete image
propRouter.delete('/:id/images/:imageId', async (req, res) => {
  try {
    const prop = await Property.findOne({ _id: req.params.id, agencyId: req.agency._id });
    if (!prop) return res.status(404).json({ ok: false, msg: 'Not found' });

    const imgIdx = prop.images.findIndex(i => i._id.toString() === req.params.imageId);
    if (imgIdx === -1) return res.status(404).json({ ok: false, msg: 'Image not found' });

    const wasMain = prop.images[imgIdx].isMain;
    const pubId   = prop.images[imgIdx].public_id;

    try { await cloudinary.uploader.destroy(pubId); } catch (_) {}
    prop.images.splice(imgIdx, 1);

    // If deleted image was main, set first remaining as main
    if (wasMain && prop.images.length > 0) prop.images[0].isMain = true;
    await prop.save();
    res.json({ ok: true, property: prop });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// Set main image
propRouter.patch('/:id/images/:imageId/main', async (req, res) => {
  try {
    const prop = await Property.findOne({ _id: req.params.id, agencyId: req.agency._id });
    if (!prop) return res.status(404).json({ ok: false, msg: 'Not found' });

    for (const img of prop.images) {
      img.isMain = img._id.toString() === req.params.imageId;
    }
    await prop.save();
    res.json({ ok: true, property: prop });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

app.use('/api/properties', propRouter);

// ──────────────────────────────────────────────
// ── AGENT ROUTES ──
// ──────────────────────────────────────────────
const agentRouter = express.Router();
agentRouter.use(authMiddleware);

agentRouter.get('/', async (req, res) => {
  try {
    const agents = await Agent.find({ agencyId: req.agency._id }).sort({ createdAt: -1 });
    res.json({ ok: true, agents });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

agentRouter.post('/', async (req, res) => {
  try {
    const { name, phone, email, title, bio } = req.body;
    if (!name || !phone) return res.status(400).json({ ok: false, msg: 'name and phone required' });
    const agent = await Agent.create({ agencyId: req.agency._id, name, phone, email, title, bio });
    res.json({ ok: true, agent });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

agentRouter.put('/:id', async (req, res) => {
  try {
    const agent = await Agent.findOneAndUpdate(
      { _id: req.params.id, agencyId: req.agency._id },
      req.body, { new: true }
    );
    if (!agent) return res.status(404).json({ ok: false, msg: 'Not found' });
    res.json({ ok: true, agent });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

agentRouter.delete('/:id', async (req, res) => {
  try {
    await Agent.deleteOne({ _id: req.params.id, agencyId: req.agency._id });
    res.json({ ok: true, msg: 'Deleted' });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

app.use('/api/agents', agentRouter);

// ──────────────────────────────────────────────
// ── LEAD ROUTES ──
// ──────────────────────────────────────────────
const leadRouter = express.Router();
leadRouter.use(authMiddleware);

leadRouter.get('/', async (req, res) => {
  try {
    const { status, type, page = 1, limit = 30 } = req.query;
    const query = { agencyId: req.agency._id };
    if (status) query.status = status;
    if (type)   query.type   = type;
    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await Lead.countDocuments(query);
    const leads = await Lead.find(query)
      .sort({ createdAt: -1 })
      .skip(skip).limit(parseInt(limit))
      .populate('propertyId', 'title type')
      .populate('agentId', 'name');
    res.json({ ok: true, leads, total });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

leadRouter.put('/:id', async (req, res) => {
  try {
    const { status, notes, agentId } = req.body;
    const lead = await Lead.findOneAndUpdate(
      { _id: req.params.id, agencyId: req.agency._id },
      { status, notes, agentId: agentId || undefined, updatedAt: new Date() },
      { new: true }
    );
    if (!lead) return res.status(404).json({ ok: false, msg: 'Not found' });
    res.json({ ok: true, lead });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

leadRouter.delete('/:id', async (req, res) => {
  try {
    await Lead.deleteOne({ _id: req.params.id, agencyId: req.agency._id });
    res.json({ ok: true, msg: 'Deleted' });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

app.use('/api/leads', leadRouter);

// ──────────────────────────────────────────────
// ── MEETING ROUTES ──
// ──────────────────────────────────────────────
const meetingRouter = express.Router();
meetingRouter.use(authMiddleware);

meetingRouter.get('/', async (req, res) => {
  try {
    const { status, date, page = 1, limit = 30 } = req.query;
    const query = { agencyId: req.agency._id };
    if (status) query.status = status;
    if (date)   query.date   = { $regex: date };
    const skip     = (parseInt(page) - 1) * parseInt(limit);
    const total    = await Meeting.countDocuments(query);
    const meetings = await Meeting.find(query)
      .sort({ createdAt: -1 })
      .skip(skip).limit(parseInt(limit))
      .populate('propertyId', 'title type city')
      .populate('agentId', 'name phone');
    res.json({ ok: true, meetings, total });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

meetingRouter.put('/:id', async (req, res) => {
  try {
    const { status, agentId, notes, time } = req.body;
    const meeting = await Meeting.findOneAndUpdate(
      { _id: req.params.id, agencyId: req.agency._id },
      { status, agentId: agentId || undefined, notes, time },
      { new: true }
    );
    if (!meeting) return res.status(404).json({ ok: false, msg: 'Not found' });
    res.json({ ok: true, meeting });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

app.use('/api/meetings', meetingRouter);

// ──────────────────────────────────────────────
// ── FAQ ROUTES ──
// ──────────────────────────────────────────────
const faqRouter = express.Router();
faqRouter.use(authMiddleware);

faqRouter.get('/', async (req, res) => {
  try {
    const faqs = await FAQ.find({ agencyId: req.agency._id }).sort({ hitCount: -1, createdAt: -1 });
    res.json({ ok: true, faqs });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

faqRouter.post('/', async (req, res) => {
  try {
    const { question, answer, keywords, category } = req.body;
    if (!question || !answer) return res.status(400).json({ ok: false, msg: 'question and answer required' });
    const kws = Array.isArray(keywords) ? keywords : (keywords ? keywords.split(',').map(s => s.trim()) : []);
    const faq = await FAQ.create({ agencyId: req.agency._id, question, answer, keywords: kws, category });
    res.json({ ok: true, faq });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

faqRouter.put('/:id', async (req, res) => {
  try {
    const { question, answer, keywords, category, isActive } = req.body;
    const kws = Array.isArray(keywords) ? keywords : (keywords ? keywords.split(',').map(s => s.trim()) : undefined);
    const update = { question, answer, category, isActive, ...(kws !== undefined && { keywords: kws }) };
    const faq = await FAQ.findOneAndUpdate(
      { _id: req.params.id, agencyId: req.agency._id },
      update, { new: true }
    );
    if (!faq) return res.status(404).json({ ok: false, msg: 'Not found' });
    res.json({ ok: true, faq });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

faqRouter.delete('/:id', async (req, res) => {
  try {
    await FAQ.deleteOne({ _id: req.params.id, agencyId: req.agency._id });
    res.json({ ok: true, msg: 'Deleted' });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

app.use('/api/faqs', faqRouter);

// ──────────────────────────────────────────────
// ── STATS ROUTE ──
// ──────────────────────────────────────────────
app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const agencyId = req.agency._id;
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

    const [
      totalProps, activeProps, soldProps,
      totalLeads, newLeads,
      meetingsToday, scheduledMeetings,
      totalMessages, inMessages
    ] = await Promise.all([
      Property.countDocuments({ agencyId }),
      Property.countDocuments({ agencyId, isActive: true, isSold: false }),
      Property.countDocuments({ agencyId, isSold: true }),
      Lead.countDocuments({ agencyId }),
      Lead.countDocuments({ agencyId, status: 'new' }),
      Meeting.countDocuments({ agencyId, createdAt: { $gte: todayStart } }),
      Meeting.countDocuments({ agencyId, status: 'scheduled' }),
      MessageLog.countDocuments({ agencyId }),
      MessageLog.countDocuments({ agencyId, direction: 'in' })
    ]);

    res.json({
      ok: true,
      stats: {
        totalProperties: totalProps,
        activeProperties: activeProps,
        soldProperties:   soldProps,
        totalLeads,
        newLeads,
        meetingsToday,
        scheduledMeetings,
        totalMessages,
        inMessages,
        messageCount: req.agency.messageCount
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// ──────────────────────────────────────────────
// ── MESSAGE HISTORY ──
// ──────────────────────────────────────────────
app.get('/api/messages', authMiddleware, async (req, res) => {
  try {
    const { phone, page = 1, limit = 50 } = req.query;
    const query = { agencyId: req.agency._id };
    if (phone) query.phone = phone;
    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await MessageLog.countDocuments(query);
    const messages = await MessageLog.find(query)
      .sort({ timestamp: -1 })
      .skip(skip).limit(parseInt(limit));
    res.json({ ok: true, messages, total });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// Unique contacts
app.get('/api/messages/contacts', authMiddleware, async (req, res) => {
  try {
    const contacts = await MessageLog.aggregate([
      { $match: { agencyId: req.agency._id } },
      { $sort:  { timestamp: -1 } },
      { $group: { _id: '$phone', lastMsg: { $first: '$body' }, lastTime: { $first: '$timestamp' }, count: { $sum: 1 } } },
      { $sort:  { lastTime: -1 } },
      { $limit: 50 }
    ]);
    res.json({ ok: true, contacts });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// ──────────────────────────────────────────────
// SERVE DASHBOARD
// ──────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

// ──────────────────────────────────────────────
// START SERVER
// ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
});

module.exports = app;
