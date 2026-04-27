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

const { SuperAdmin, Agency, Agent, Property, Lead, Meeting, FAQ, Session, MessageLog } = require('./models');
const { clients, qrCodes, statuses, initClient, startAllSessions } = require('./bot');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// ──────────────────────────────────────────────
// CLOUDINARY
// ──────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: 'realestateai',
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
// MONGODB
// ──────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/realestateai', {
  useNewUrlParser: true, useUnifiedTopology: true
}).then(async () => {
  console.log('✅ MongoDB connected');
  await createDefaultSuperAdmin();
  startAllSessions();
}).catch(err => console.error('❌ MongoDB error:', err.message));

// ──────────────────────────────────────────────
// CREATE DEFAULT SUPER ADMIN
// ──────────────────────────────────────────────
async function createDefaultSuperAdmin() {
  try {
    const existing = await SuperAdmin.findOne({ username: process.env.SUPER_ADMIN_USER || 'superadmin' });
    if (!existing) {
      const hashed = await bcrypt.hash(process.env.SUPER_ADMIN_PASS || 'Admin@1234', 10);
      await SuperAdmin.create({
        username: process.env.SUPER_ADMIN_USER || 'superadmin',
        password: hashed
      });
      console.log('✅ Super Admin created — username: superadmin, password: Admin@1234');
    }
  } catch (err) {
    console.error('SuperAdmin create error:', err.message);
  }
}

// ──────────────────────────────────────────────
// AGENCY AUTH MIDDLEWARE
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

    // Check if blocked
    if (agency.isBlocked) return res.status(403).json({ ok: false, msg: 'Account blocked. Contact support.' });

    // Check if approved
    if (!agency.isApproved) return res.status(403).json({ ok: false, msg: 'Account pending approval. Please wait.' });

    // Check expiry
    if (agency.expiryDate && new Date() > agency.expiryDate) {
      return res.status(403).json({ ok: false, msg: 'Subscription expired. Please renew.' });
    }

    req.agency = agency;
    next();
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
}

// ──────────────────────────────────────────────
// SUPER ADMIN AUTH MIDDLEWARE
// ──────────────────────────────────────────────
async function superAdminAuth(req, res, next) {
  try {
    const username = req.headers['x-super-user'];
    const password = req.headers['x-super-pass'];
    if (!username || !password) return res.status(401).json({ ok: false, msg: 'Super admin credentials required' });

    const admin = await SuperAdmin.findOne({ username });
    if (!admin) return res.status(401).json({ ok: false, msg: 'Invalid super admin' });

    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) return res.status(401).json({ ok: false, msg: 'Invalid password' });

    req.superAdmin = admin;
    next();
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
}

// ══════════════════════════════════════════════
// SUPER ADMIN ROUTES
// ══════════════════════════════════════════════
const superRouter = express.Router();
superRouter.use(superAdminAuth);

// Login check
superRouter.post('/login', (req, res) => {
  res.json({ ok: true, msg: 'Super Admin authenticated', admin: { username: req.superAdmin.username } });
});

// Get all agencies
superRouter.get('/agencies', async (req, res) => {
  try {
    const agencies = await Agency.find({}).sort({ createdAt: -1 }).select('-password');
    res.json({ ok: true, agencies });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// Approve agency
superRouter.patch('/agencies/:id/approve', async (req, res) => {
  try {
    const { plan, days } = req.body;
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + (parseInt(days) || 30));

    const agency = await Agency.findByIdAndUpdate(
      req.params.id,
      {
        isApproved: true,
        isActive:   true,
        isBlocked:  false,
        plan:       plan || 'basic',
        expiryDate
      },
      { new: true, select: '-password' }
    );
    if (!agency) return res.status(404).json({ ok: false, msg: 'Agency not found' });
    res.json({ ok: true, agency });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// Block agency
superRouter.patch('/agencies/:id/block', async (req, res) => {
  try {
    const agency = await Agency.findByIdAndUpdate(
      req.params.id,
      { isBlocked: true, isActive: false },
      { new: true, select: '-password' }
    );
    if (!agency) return res.status(404).json({ ok: false, msg: 'Not found' });

    // Disconnect WhatsApp if connected
    const agencyId = req.params.id;
    if (clients.has(agencyId)) {
      try { await clients.get(agencyId).destroy(); } catch (_) {}
      clients.delete(agencyId);
      statuses.set(agencyId, 'blocked');
    }
    res.json({ ok: true, agency });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// Unblock agency
superRouter.patch('/agencies/:id/unblock', async (req, res) => {
  try {
    const agency = await Agency.findByIdAndUpdate(
      req.params.id,
      { isBlocked: false, isActive: true },
      { new: true, select: '-password' }
    );
    if (!agency) return res.status(404).json({ ok: false, msg: 'Not found' });
    res.json({ ok: true, agency });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// Mark payment received
superRouter.patch('/agencies/:id/payment', async (req, res) => {
  try {
    const { amount, ref, plan, days } = req.body;
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + (parseInt(days) || 30));

    const agency = await Agency.findByIdAndUpdate(
      req.params.id,
      {
        isPaid:        true,
        paymentDate:   new Date(),
        paymentRef:    ref,
        paymentAmount: amount,
        plan:          plan || 'basic',
        expiryDate,
        isApproved:    true,
        isActive:      true
      },
      { new: true, select: '-password' }
    );
    if (!agency) return res.status(404).json({ ok: false, msg: 'Not found' });
    res.json({ ok: true, agency });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// Extend expiry
superRouter.patch('/agencies/:id/extend', async (req, res) => {
  try {
    const { days } = req.body;
    const agency = await Agency.findById(req.params.id);
    if (!agency) return res.status(404).json({ ok: false, msg: 'Not found' });

    const base = agency.expiryDate && agency.expiryDate > new Date() ? agency.expiryDate : new Date();
    base.setDate(base.getDate() + (parseInt(days) || 30));

    agency.expiryDate = base;
    await agency.save();
    res.json({ ok: true, agency });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// Delete agency
superRouter.delete('/agencies/:id', async (req, res) => {
  try {
    await Agency.deleteOne({ _id: req.params.id });
    await Property.deleteMany({ agencyId: req.params.id });
    await Lead.deleteMany({ agencyId: req.params.id });
    await Meeting.deleteMany({ agencyId: req.params.id });
    await Agent.deleteMany({ agencyId: req.params.id });
    await FAQ.deleteMany({ agencyId: req.params.id });
    await Session.deleteMany({ agencyId: req.params.id });
    await MessageLog.deleteMany({ agencyId: req.params.id });
    res.json({ ok: true, msg: 'Agency and all data deleted' });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// Super admin stats
superRouter.get('/stats', async (req, res) => {
  try {
    const [total, approved, pending, blocked, paid] = await Promise.all([
      Agency.countDocuments({}),
      Agency.countDocuments({ isApproved: true }),
      Agency.countDocuments({ isApproved: false }),
      Agency.countDocuments({ isBlocked: true }),
      Agency.countDocuments({ isPaid: true })
    ]);
    res.json({ ok: true, stats: { total, approved, pending, blocked, paid } });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// Change super admin password
superRouter.put('/password', async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ ok: false, msg: 'Too short' });
    const hashed = await bcrypt.hash(newPassword, 10);
    await SuperAdmin.findByIdAndUpdate(req.superAdmin._id, { password: hashed });
    res.json({ ok: true, msg: 'Password updated' });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

app.use('/api/super', superRouter);

// ══════════════════════════════════════════════
// AGENCY ROUTES
// ══════════════════════════════════════════════
const agencyRouter = express.Router();

agencyRouter.post('/register', async (req, res) => {
  try {
    const { name, phone, password, email, city, address } = req.body;
    if (!name || !phone || !password) return res.status(400).json({ ok: false, msg: 'name, phone, password required' });

    const exists = await Agency.findOne({ phone });
    if (exists) return res.status(409).json({ ok: false, msg: 'Phone already registered' });

    const hashed = await bcrypt.hash(password, 10);
    const agency = await Agency.create({
      name, phone, password: hashed, email, city, address,
      isActive: false, isApproved: false  // pending approval
    });
    res.json({ ok: true, msg: 'Registration successful! Waiting for admin approval.', agency: { _id: agency._id, name: agency.name, phone: agency.phone } });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

agencyRouter.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const agency = await Agency.findOne({ phone });
    if (!agency) return res.status(401).json({ ok: false, msg: 'Agency not found' });

    const valid = await bcrypt.compare(password, agency.password);
    if (!valid) return res.status(401).json({ ok: false, msg: 'Invalid password' });

    if (agency.isBlocked) return res.status(403).json({ ok: false, msg: '🚫 Account blocked. Contact support.' });
    if (!agency.isApproved) return res.status(403).json({ ok: false, msg: '⏳ Account pending approval. Please wait.' });
    if (agency.expiryDate && new Date() > agency.expiryDate) return res.status(403).json({ ok: false, msg: '❌ Subscription expired. Please renew.' });

    res.json({
      ok: true,
      agency: {
        _id: agency._id, name: agency.name, phone: agency.phone,
        city: agency.city, email: agency.email, currency: agency.currency,
        greetingMsg: agency.greetingMsg, plan: agency.plan,
        expiryDate: agency.expiryDate, isPaid: agency.isPaid
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

agencyRouter.get('/settings', authMiddleware, async (req, res) => {
  try {
    const a = req.agency;
    res.json({ ok: true, agency: { _id: a._id, name: a.name, phone: a.phone, email: a.email, address: a.address, city: a.city, website: a.website, currency: a.currency, greetingMsg: a.greetingMsg, plan: a.plan, messageCount: a.messageCount, expiryDate: a.expiryDate, isPaid: a.isPaid } });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

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

// ══════════════════════════════════════════════
// WHATSAPP ROUTES
// ══════════════════════════════════════════════
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
    const agency  = req.agency;
    const id      = agency._id.toString();
    const current = statuses.get(id);
    if (current === 'connected' || current === 'initializing') {
      return res.json({ ok: true, msg: `Already ${current}`, status: current });
    }
    initClient(agency).catch(err => { statuses.set(id, 'error'); });
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
    initClient(agency).catch(() => statuses.set(id, 'error'));
    res.json({ ok: true, msg: 'Restarting session' });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

app.use('/api/wa', waRouter);

// ══════════════════════════════════════════════
// PROPERTY ROUTES
// ══════════════════════════════════════════════
const propRouter = express.Router();
propRouter.use(authMiddleware);

propRouter.get('/', async (req, res) => {
  try {
    const { type, isActive, isSold, search, page = 1, limit = 20 } = req.query;
    const query = { agencyId: req.agency._id };
    if (type) query.type = type;
    if (isActive !== undefined) query.isActive = isActive === 'true';
    if (isSold   !== undefined) query.isSold   = isSold   === 'true';
    if (search) query.$or = [
      { title: { $regex: search, $options: 'i' } },
      { city:  { $regex: search, $options: 'i' } }
    ];
    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await Property.countDocuments(query);
    const props = await Property.find(query).sort({ isFeatured: -1, createdAt: -1 }).skip(skip).limit(parseInt(limit)).populate('agentId', 'name phone');
    res.json({ ok: true, properties: props, total, page: parseInt(page) });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

propRouter.get('/:id', async (req, res) => {
  try {
    const prop = await Property.findOne({ _id: req.params.id, agencyId: req.agency._id }).populate('agentId', 'name phone email');
    if (!prop) return res.status(404).json({ ok: false, msg: 'Not found' });
    res.json({ ok: true, property: prop });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

propRouter.post('/', async (req, res) => {
  try {
    const { title, type, price, ...rest } = req.body;
    if (!title || !type || price === undefined) return res.status(400).json({ ok: false, msg: 'title, type, price required' });
    const features = Array.isArray(rest.features) ? rest.features : (rest.features ? rest.features.split(',').map(s => s.trim()) : []);
    const prop = await Property.create({ agencyId: req.agency._id, title, type, price: parseFloat(price), ...rest, features });
    res.json({ ok: true, property: prop });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

propRouter.put('/:id', async (req, res) => {
  try {
    const update = { ...req.body, updatedAt: new Date() };
    if (update.features && !Array.isArray(update.features)) update.features = update.features.split(',').map(s => s.trim());
    const prop = await Property.findOneAndUpdate({ _id: req.params.id, agencyId: req.agency._id }, update, { new: true });
    if (!prop) return res.status(404).json({ ok: false, msg: 'Not found' });
    res.json({ ok: true, property: prop });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

propRouter.patch('/:id/sold', async (req, res) => {
  try {
    const prop = await Property.findOneAndUpdate({ _id: req.params.id, agencyId: req.agency._id }, { isSold: !!req.body.isSold, updatedAt: new Date() }, { new: true });
    if (!prop) return res.status(404).json({ ok: false, msg: 'Not found' });
    res.json({ ok: true, property: prop });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

propRouter.delete('/:id', async (req, res) => {
  try {
    const prop = await Property.findOne({ _id: req.params.id, agencyId: req.agency._id });
    if (!prop) return res.status(404).json({ ok: false, msg: 'Not found' });
    for (const img of prop.images) { try { await cloudinary.uploader.destroy(img.public_id); } catch (_) {} }
    await Property.deleteOne({ _id: req.params.id });
    res.json({ ok: true, msg: 'Deleted' });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

propRouter.post('/:id/images', upload.array('images', 5), async (req, res) => {
  try {
    const prop = await Property.findOne({ _id: req.params.id, agencyId: req.agency._id });
    if (!prop) return res.status(404).json({ ok: false, msg: 'Not found' });
    if (!req.files || !req.files.length) return res.status(400).json({ ok: false, msg: 'No files' });
    const hasMain = prop.images.some(i => i.isMain);
    req.files.forEach((f, i) => prop.images.push({ url: f.path, public_id: f.filename, isMain: !hasMain && i === 0 }));
    await prop.save();
    res.json({ ok: true, property: prop });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

propRouter.delete('/:id/images/:imageId', async (req, res) => {
  try {
    const prop = await Property.findOne({ _id: req.params.id, agencyId: req.agency._id });
    if (!prop) return res.status(404).json({ ok: false, msg: 'Not found' });
    const idx = prop.images.findIndex(i => i._id.toString() === req.params.imageId);
    if (idx === -1) return res.status(404).json({ ok: false, msg: 'Image not found' });
    const wasMain = prop.images[idx].isMain;
    try { await cloudinary.uploader.destroy(prop.images[idx].public_id); } catch (_) {}
    prop.images.splice(idx, 1);
    if (wasMain && prop.images.length > 0) prop.images[0].isMain = true;
    await prop.save();
    res.json({ ok: true, property: prop });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

propRouter.patch('/:id/images/:imageId/main', async (req, res) => {
  try {
    const prop = await Property.findOne({ _id: req.params.id, agencyId: req.agency._id });
    if (!prop) return res.status(404).json({ ok: false, msg: 'Not found' });
    prop.images.forEach(img => { img.isMain = img._id.toString() === req.params.imageId; });
    await prop.save();
    res.json({ ok: true, property: prop });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

app.use('/api/properties', propRouter);

// ══════════════════════════════════════════════
// AGENT ROUTES
// ══════════════════════════════════════════════
const agentRouter = express.Router();
agentRouter.use(authMiddleware);

agentRouter.get('/', async (req, res) => {
  try {
    const agents = await Agent.find({ agencyId: req.agency._id }).sort({ createdAt: -1 });
    res.json({ ok: true, agents });
  } catch (err) { res.status(500).json({ ok: false, msg: err.message }); }
});

agentRouter.post('/', async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name || !phone) return res.status(400).json({ ok: false, msg: 'name and phone required' });
    const agent = await Agent.create({ agencyId: req.agency._id, ...req.body });
    res.json({ ok: true, agent });
  } catch (err) { res.status(500).json({ ok: false, msg: err.message }); }
});

agentRouter.put('/:id', async (req, res) => {
  try {
    const agent = await Agent.findOneAndUpdate({ _id: req.params.id, agencyId: req.agency._id }, req.body, { new: true });
    if (!agent) return res.status(404).json({ ok: false, msg: 'Not found' });
    res.json({ ok: true, agent });
  } catch (err) { res.status(500).json({ ok: false, msg: err.message }); }
});

agentRouter.delete('/:id', async (req, res) => {
  try {
    await Agent.deleteOne({ _id: req.params.id, agencyId: req.agency._id });
    res.json({ ok: true, msg: 'Deleted' });
  } catch (err) { res.status(500).json({ ok: false, msg: err.message }); }
});

app.use('/api/agents', agentRouter);

// ══════════════════════════════════════════════
// LEAD ROUTES
// ══════════════════════════════════════════════
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
    const leads = await Lead.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).populate('propertyId', 'title type').populate('agentId', 'name');
    res.json({ ok: true, leads, total });
  } catch (err) { res.status(500).json({ ok: false, msg: err.message }); }
});

leadRouter.put('/:id', async (req, res) => {
  try {
    const lead = await Lead.findOneAndUpdate({ _id: req.params.id, agencyId: req.agency._id }, { ...req.body, updatedAt: new Date() }, { new: true });
    if (!lead) return res.status(404).json({ ok: false, msg: 'Not found' });
    res.json({ ok: true, lead });
  } catch (err) { res.status(500).json({ ok: false, msg: err.message }); }
});

leadRouter.delete('/:id', async (req, res) => {
  try {
    await Lead.deleteOne({ _id: req.params.id, agencyId: req.agency._id });
    res.json({ ok: true, msg: 'Deleted' });
  } catch (err) { res.status(500).json({ ok: false, msg: err.message }); }
});

app.use('/api/leads', leadRouter);

// ══════════════════════════════════════════════
// MEETING ROUTES
// ══════════════════════════════════════════════
const meetingRouter = express.Router();
meetingRouter.use(authMiddleware);

meetingRouter.get('/', async (req, res) => {
  try {
    const { status, page = 1, limit = 30 } = req.query;
    const query = { agencyId: req.agency._id };
    if (status) query.status = status;
    const skip     = (parseInt(page) - 1) * parseInt(limit);
    const total    = await Meeting.countDocuments(query);
    const meetings = await Meeting.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).populate('propertyId', 'title type city').populate('agentId', 'name phone');
    res.json({ ok: true, meetings, total });
  } catch (err) { res.status(500).json({ ok: false, msg: err.message }); }
});

meetingRouter.put('/:id', async (req, res) => {
  try {
    const meeting = await Meeting.findOneAndUpdate({ _id: req.params.id, agencyId: req.agency._id }, req.body, { new: true });
    if (!meeting) return res.status(404).json({ ok: false, msg: 'Not found' });
    res.json({ ok: true, meeting });
  } catch (err) { res.status(500).json({ ok: false, msg: err.message }); }
});

app.use('/api/meetings', meetingRouter);

// ══════════════════════════════════════════════
// FAQ ROUTES
// ══════════════════════════════════════════════
const faqRouter = express.Router();
faqRouter.use(authMiddleware);

faqRouter.get('/', async (req, res) => {
  try {
    const faqs = await FAQ.find({ agencyId: req.agency._id }).sort({ hitCount: -1, createdAt: -1 });
    res.json({ ok: true, faqs });
  } catch (err) { res.status(500).json({ ok: false, msg: err.message }); }
});

faqRouter.post('/', async (req, res) => {
  try {
    const { question, answer, keywords, category } = req.body;
    if (!question || !answer) return res.status(400).json({ ok: false, msg: 'question and answer required' });
    const kws = Array.isArray(keywords) ? keywords : (keywords ? keywords.split(',').map(s => s.trim()) : []);
    const faq = await FAQ.create({ agencyId: req.agency._id, question, answer, keywords: kws, category });
    res.json({ ok: true, faq });
  } catch (err) { res.status(500).json({ ok: false, msg: err.message }); }
});

faqRouter.put('/:id', async (req, res) => {
  try {
    const { keywords, ...rest } = req.body;
    const update = { ...rest };
    if (keywords !== undefined) update.keywords = Array.isArray(keywords) ? keywords : keywords.split(',').map(s => s.trim());
    const faq = await FAQ.findOneAndUpdate({ _id: req.params.id, agencyId: req.agency._id }, update, { new: true });
    if (!faq) return res.status(404).json({ ok: false, msg: 'Not found' });
    res.json({ ok: true, faq });
  } catch (err) { res.status(500).json({ ok: false, msg: err.message }); }
});

faqRouter.delete('/:id', async (req, res) => {
  try {
    await FAQ.deleteOne({ _id: req.params.id, agencyId: req.agency._id });
    res.json({ ok: true, msg: 'Deleted' });
  } catch (err) { res.status(500).json({ ok: false, msg: err.message }); }
});

app.use('/api/faqs', faqRouter);

// ══════════════════════════════════════════════
// STATS
// ══════════════════════════════════════════════
app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const agencyId   = req.agency._id;
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const [totalProps, activeProps, soldProps, totalLeads, newLeads, meetingsToday, scheduledMeetings, totalMessages, inMessages] = await Promise.all([
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
    res.json({ ok: true, stats: { totalProperties: totalProps, activeProperties: activeProps, soldProperties: soldProps, totalLeads, newLeads, meetingsToday, scheduledMeetings, totalMessages, inMessages, messageCount: req.agency.messageCount } });
  } catch (err) { res.status(500).json({ ok: false, msg: err.message }); }
});

// ══════════════════════════════════════════════
// MESSAGES
// ══════════════════════════════════════════════
app.get('/api/messages', authMiddleware, async (req, res) => {
  try {
    const { phone, page = 1, limit = 50 } = req.query;
    const query = { agencyId: req.agency._id };
    if (phone) query.phone = phone;
    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await MessageLog.countDocuments(query);
    const messages = await MessageLog.find(query).sort({ timestamp: -1 }).skip(skip).limit(parseInt(limit));
    res.json({ ok: true, messages, total });
  } catch (err) { res.status(500).json({ ok: false, msg: err.message }); }
});

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
  } catch (err) { res.status(500).json({ ok: false, msg: err.message }); }
});

// ══════════════════════════════════════════════
// SERVE DASHBOARD
// ══════════════════════════════════════════════
app.get('/superadmin', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/superadmin.html'));
});
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
});

module.exports = app;
