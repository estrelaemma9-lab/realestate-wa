const mongoose = require('mongoose');

// ──────────────────────────────────────────────
// AGENCY MODEL
// ──────────────────────────────────────────────
const agencySchema = new mongoose.Schema({
  name:        { type: String, required: true },
  phone:       { type: String, required: true, unique: true },
  password:    { type: String, required: true },
  email:       { type: String },
  address:     { type: String },
  city:        { type: String },
  website:     { type: String },
  logoUrl:     { type: String },
  currency:    { type: String, default: 'PKR' },
  greetingMsg: { type: String, default: 'Welcome to our Real Estate Service! How can we help you today?' },
  primaryColor:{ type: String, default: '#2563eb' },
  isActive:    { type: Boolean, default: true },
  plan:        { type: String, enum: ['trial', 'basic', 'pro'], default: 'trial' },
  messageCount:{ type: Number, default: 0 },
  createdAt:   { type: Date, default: Date.now }
});

// ──────────────────────────────────────────────
// AGENT MODEL
// ──────────────────────────────────────────────
const agentSchema = new mongoose.Schema({
  agencyId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Agency', required: true },
  name:      { type: String, required: true },
  phone:     { type: String, required: true },
  email:     { type: String },
  title:     { type: String, default: 'Real Estate Agent' },
  bio:       { type: String },
  avatarUrl: { type: String },
  isActive:  { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

// ──────────────────────────────────────────────
// PROPERTY MODEL
// ──────────────────────────────────────────────
const propertyImageSchema = new mongoose.Schema({
  url:       { type: String, required: true },
  public_id: { type: String, required: true },
  isMain:    { type: Boolean, default: false }
});

const propertySchema = new mongoose.Schema({
  agencyId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Agency', required: true },
  agentId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Agent' },
  title:       { type: String, required: true },
  description: { type: String },
  type:        { type: String, enum: ['buy', 'rent', 'commercial'], required: true },
  category:    { type: String, enum: ['house', 'apartment', 'plot', 'shop', 'office', 'warehouse', 'villa', 'farmhouse'], default: 'house' },
  price:       { type: Number, required: true },
  priceUnit:   { type: String, default: 'PKR' },
  priceLabel:  { type: String },
  area:        { type: Number },
  areaUnit:    { type: String, default: 'Marla' },
  bedrooms:    { type: Number, default: 0 },
  bathrooms:   { type: Number, default: 0 },
  address:     { type: String },
  city:        { type: String },
  location:    { type: String },
  features:    [{ type: String }],
  images:      [propertyImageSchema],
  isActive:    { type: Boolean, default: true },
  isSold:      { type: Boolean, default: false },
  isFeatured:  { type: Boolean, default: false },
  viewCount:   { type: Number, default: 0 },
  createdAt:   { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now }
});

propertySchema.virtual('mainImage').get(function () {
  const main = this.images.find(i => i.isMain);
  return main ? main.url : (this.images[0] ? this.images[0].url : null);
});

propertySchema.set('toJSON', { virtuals: true });
propertySchema.set('toObject', { virtuals: true });

// ──────────────────────────────────────────────
// LEAD MODEL
// ──────────────────────────────────────────────
const leadSchema = new mongoose.Schema({
  agencyId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Agency', required: true },
  agentId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Agent' },
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property' },
  name:       { type: String },
  phone:      { type: String, required: true },
  message:    { type: String },
  type:       { type: String, enum: ['buy', 'rent', 'sell', 'commercial', 'general'], default: 'general' },
  status:     { type: String, enum: ['new', 'contacted', 'interested', 'negotiating', 'closed', 'lost'], default: 'new' },
  notes:      { type: String },
  budget:     { type: String },
  area:       { type: String },
  source:     { type: String, default: 'whatsapp' },
  createdAt:  { type: Date, default: Date.now },
  updatedAt:  { type: Date, default: Date.now }
});

// ──────────────────────────────────────────────
// MEETING MODEL
// ──────────────────────────────────────────────
const meetingSchema = new mongoose.Schema({
  agencyId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Agency', required: true },
  agentId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Agent' },
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property' },
  leadId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
  clientName: { type: String, required: true },
  clientPhone:{ type: String, required: true },
  date:       { type: String, required: true },
  time:       { type: String },
  status:     { type: String, enum: ['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show'], default: 'scheduled' },
  token:      { type: String },
  notes:      { type: String },
  createdAt:  { type: Date, default: Date.now }
});

// ──────────────────────────────────────────────
// FAQ MODEL
// ──────────────────────────────────────────────
const faqSchema = new mongoose.Schema({
  agencyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agency', required: true },
  question: { type: String, required: true },
  answer:   { type: String, required: true },
  keywords: [{ type: String }],
  category: { type: String, default: 'general' },
  isActive: { type: Boolean, default: true },
  hitCount: { type: Number, default: 0 },
  createdAt:{ type: Date, default: Date.now }
});

// ──────────────────────────────────────────────
// CONVERSATION SESSION MODEL
// ──────────────────────────────────────────────
const sessionSchema = new mongoose.Schema({
  agencyId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Agency', required: true },
  phone:     { type: String, required: true },
  step:      { type: String, default: 'START' },
  lang:      { type: String, default: 'en' },
  pending:   { type: mongoose.Schema.Types.Mixed, default: {} },
  lastActive:{ type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
});

sessionSchema.index({ agencyId: 1, phone: 1 }, { unique: true });

// ──────────────────────────────────────────────
// MESSAGE LOG MODEL
// ──────────────────────────────────────────────
const messageLogSchema = new mongoose.Schema({
  agencyId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Agency', required: true },
  phone:     { type: String, required: true },
  direction: { type: String, enum: ['in', 'out'], required: true },
  body:      { type: String },
  type:      { type: String, default: 'text' },
  timestamp: { type: Date, default: Date.now }
});

messageLogSchema.index({ agencyId: 1, phone: 1, timestamp: -1 });

// ──────────────────────────────────────────────
// EXPORTS
// ──────────────────────────────────────────────
const Agency      = mongoose.model('Agency', agencySchema);
const Agent       = mongoose.model('Agent', agentSchema);
const Property    = mongoose.model('Property', propertySchema);
const Lead        = mongoose.model('Lead', leadSchema);
const Meeting     = mongoose.model('Meeting', meetingSchema);
const FAQ         = mongoose.model('FAQ', faqSchema);
const Session     = mongoose.model('Session', sessionSchema);
const MessageLog  = mongoose.model('MessageLog', messageLogSchema);

module.exports = { Agency, Agent, Property, Lead, Meeting, FAQ, Session, MessageLog };
