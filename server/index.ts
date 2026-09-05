// MERGED PRODUCTION ENTRY — server/index.ts
// Single API for website + Windows desktop (Untangled Nexus).
// Includes: public quotes/orders, admin assignment/status, director-review,
// auth, attendance, dashboard, employees, tasks, notifications,
// and PATCH /api/orders/status.
// Prefer this single entry over legacy index-desktop / index-working-v2.

// Backend/server/index-desktop.ts
import { createServer } from 'node:http';
import { createApp, eventHandler, toNodeListener, readBody, getQuery } from 'h3';
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { config as sharedConfig, assertProductionConfig } from './config/index.js';
import { securityMiddleware, rateLimitOrNull } from './middleware/security.js';
import { performanceMiddleware } from './middleware/performance.js';

// Load environment variables
dotenv.config();

// ============================================
// CONFIGURATION - ALL FROM ENV VARIABLES
// ============================================

const config = {
  port: parseInt(process.env.PORT || '5001'),
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/untangled_its',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  nodeEnv: process.env.NODE_ENV || 'development',
};

console.log('📋 Configuration:');
console.log(`   PORT: ${config.port}`);
const maskedUri = config.mongoUri ? config.mongoUri.replace(/\/\/.*@/, '//<credentials>@') : 'undefined';
console.log(`   MONGODB_URI: ${maskedUri}`);
console.log(`   FRONTEND_URL: ${config.frontendUrl}`);
console.log(`   NODE_ENV: ${config.nodeEnv}`);

// ============================================
// MONGODB MODELS
// ============================================

const quoteSchema = new mongoose.Schema({
  reference: { type: String, unique: true, required: true },
  customerName: { type: String, required: true },
  company: String,
  email: { type: String, required: true },
  phone: { type: String, required: true },
  notes: String,
  // Client delivery / site details (from website quote form)
  address: { type: String, default: '' },
  delivery_address: { type: String, default: '' },
  delivery_date: { type: String, default: '' },
  preferred_delivery_date: { type: String, default: '' },
  site_notes: { type: String, default: '' },
  delivery: {
    address: String,
    date: String,
    driver: String,
    status: String,
  },
  items: [{
    id: String,
    name: String,
    kind: String,
    qty: Number,
    image: String,
    price: Number,
    specs: [String],
    note: String,
  }],
  // Quotation built by ops desktop
  quotation: { type: [mongoose.Schema.Types.Mixed], default: [] },
  quotation_total: { type: Number, default: 0 },
  status: { 
    type: String, 
    enum: [
      'received', 'in_review', 'quoted', 'closed', 'pending', 'waiting_feedback',
      'in_touch', 'approved', 'payment', 'assigned', 'accepted', 'in_progress',
      'awaiting_client', 'awaiting_client_approval', 'awaiting_details',
      'awaiting_payment', 'awaiting_director', 'paid',
      'out_for_delivery', 'completed', 'returned', 'rejected'
    ],
    default: 'received'
  },
  replyMessage: String,
  repliedAt: Date,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  paymentRequired: { type: Boolean, default: false },
  paymentAmount: { type: Number },
  paymentStatus: { 
    type: String, 
    enum: ['pending', 'paid', 'failed'],
    default: 'pending'
  },
  paymentReference: { type: String },
  assigned_to: { type: mongoose.Schema.Types.Mixed, default: null },
  assigned_by: { type: mongoose.Schema.Types.Mixed, default: null },
  assignedEmployeeId: { type: mongoose.Schema.Types.Mixed, default: null },
  assignedAt: { type: Date },
  history: { type: [mongoose.Schema.Types.Mixed], default: [] },
  directorReview: { type: mongoose.Schema.Types.Mixed, default: null },
  progress: { type: Number },
  completed_at: { type: Date },
  completed_by: { type: String },
  accepted_at: { type: Date },
  accepted_by: { type: String },
  feedback: {
    rating: { type: Number, min: 1, max: 5 },
    comment: { type: String },
    submitted: { type: Boolean, default: false },
    submittedAt: { type: Date }
  }
});

// ✅ FIXED: Removed orderId - using reference as unique identifier
const orderSchema = new mongoose.Schema({
  reference: { type: String, unique: true, required: true, index: true },
  customerName: { type: String, required: true },
  company: String,
  email: { type: String, required: true, index: true },
  phone: { type: String, required: true },
  address: { type: String, required: true },
  notes: String,
  items: [{
    id: String,
    name: String,
    qty: Number,
    price: Number
  }],
  total: { type: Number, required: true },
  status: { 
    type: String, 
    // Must match Work desktop Order Management statuses
    enum: [
      'pending',
      'confirmed',
      'processing',
      'assigned',
      'in_progress',
      'ready',
      'awaiting_payment',
      'paid',
      'shipped',
      'delivered',
      'completed',
      'cancelled',
    ],
    default: 'pending'
  },
  trackingNumber: String,
  carrier: String,
  estimatedDelivery: Date,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  assigned_to: { type: mongoose.Schema.Types.Mixed, default: null },
  assigned_by: { type: mongoose.Schema.Types.Mixed, default: null }
});

// Create models
const Quote = mongoose.models.Quote || mongoose.model('Quote', quoteSchema);
const Order = mongoose.models.Order || mongoose.model('Order', orderSchema);

// ============================================
// CONNECT TO MONGODB
// ============================================

let isMongoConnected = false;


async function ensurePerformanceIndexes() {
  const db = mongoose.connection.db;
  if (!db) return;

  // Atlas may already contain indexes created by the previous API version.
  // Match indexes by key pattern before creating anything, so a different
  // index name (for example status_1 vs approvals_status_1) never causes
  // IndexOptionsConflict and never forces the API into in-memory mode.
  const ensureIndex = async (collectionName: string, keys: Record<string, 1 | -1>, name: string) => {
    const collection = db.collection(collectionName);
    // createIndex creates the collection if it does not exist yet.
    // Avoid listIndexes first — Atlas throws NamespaceNotFound (code 26)
    // when the collection has never been created (e.g. test.notifications).
    try {
      return await collection.createIndex(keys, { name, background: true });
    } catch (error: any) {
      const code = error?.code || error?.codeName;
      // Index already exists under another name, or concurrent create — OK
      if (
        code === 85 ||
        code === 86 ||
        code === 'IndexOptionsConflict' ||
        code === 'IndexKeySpecsConflict' ||
        code === 26 ||
        code === 'NamespaceNotFound'
      ) {
        try {
          // One more attempt after ensuring collection exists
          await db.createCollection(collectionName).catch(() => null);
          return await collection.createIndex(keys, { name, background: true });
        } catch (e2: any) {
          const c2 = e2?.code || e2?.codeName;
          if (
            c2 === 85 ||
            c2 === 86 ||
            c2 === 'IndexOptionsConflict' ||
            c2 === 'IndexKeySpecsConflict' ||
            String(e2?.message || '').includes('already exists')
          ) {
            return name;
          }
          console.warn(`⚠️ Index ${name} on ${collectionName} skipped:`, e2?.message || e2);
          return null;
        }
      }
      console.warn(`⚠️ Index ${name} on ${collectionName} skipped:`, error?.message || error);
      return null;
    }
  };

  const indexJobs = [
    ensureIndex('users', { username: 1 }, 'users_username_1'),
    ensureIndex('users', { email: 1 }, 'users_email_1'),
    ensureIndex('users', { employee_id: 1 }, 'users_employee_id_1'),
    ensureIndex('api_sessions', { token: 1 }, 'api_sessions_token_1'),
    ensureIndex('api_sessions', { user_id: 1, status: 1 }, 'api_sessions_user_status'),
    ensureIndex('employees', { employee_id: 1 }, 'employees_employee_id_1'),
    ensureIndex('employees', { email: 1 }, 'employees_email_1'),
    ensureIndex('employees', { status: 1 }, 'employees_status_1'),
    ensureIndex('attendance', { employee_id: 1, work_date: 1 }, 'attendance_employee_date'),
    ensureIndex('attendance', { work_date: 1, clock_out_at: 1, status: 1 }, 'attendance_open_today'),
    ensureIndex('work_assignments', { due_date: 1, status: 1 }, 'work_due_status'),
    ensureIndex('work_assignments', { assigned_employee: 1, status: 1 }, 'work_assignee_status'),
    ensureIndex('work_assignments', { created_at: -1 }, 'work_created_desc'),
    ensureIndex('notifications', { is_read: 1, created_at: -1 }, 'notifications_unread_created'),
    ensureIndex('notifications', { recipient_name: 1, is_read: 1 }, 'notifications_recipient_read'),
    ensureIndex('notifications', { recipient_role: 1, is_read: 1 }, 'notifications_role_read'),
    ensureIndex('approvals', { status: 1 }, 'approvals_status_1'),
  ];
  await Promise.allSettled(indexJobs);
  console.log('✅ Performance indexes ensured (missing collections auto-created)');
}

function syncMongoFlag() {
  // readyState: 0=disconnected 1=connected 2=connecting 3=disconnecting
  isMongoConnected = mongoose.connection.readyState === 1;
  return isMongoConnected;
}

async function connectDB() {
  try {
    console.log('📡 Connecting to MongoDB...');

    if (!config.mongoUri) {
      console.error('❌ MONGODB_URI is not defined in environment variables');
      console.log('⚠️ Falling back to in-memory storage...');
      isMongoConnected = false;
      return false;
    }

    // Already connected (Render warm instance / hot reload)
    if (mongoose.connection.readyState === 1) {
      isMongoConnected = true;
      console.log('✅ MongoDB already connected');
      return true;
    }

    const maskedUri = config.mongoUri.replace(/\/\/.*@/, '//<credentials>@');
    console.log(`🔗 Using URI: ${maskedUri}`);

    const mongoOptions: any = {
      maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 20),
      minPoolSize: Number(process.env.MONGODB_MIN_POOL_SIZE || 2),
      maxIdleTimeMS: Number(process.env.MONGODB_MAX_IDLE_TIME_MS || 60000),
      serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 15000),
      socketTimeoutMS: Number(process.env.MONGODB_SOCKET_TIMEOUT_MS || 45000),
      connectTimeoutMS: Number(process.env.MONGODB_CONNECT_TIMEOUT_MS || 15000),
      family: 4,
      ...(process.env.MONGODB_TLS === 'true' ? {
        tls: true,
        tlsAllowInvalidCertificates: false,
        tlsAllowInvalidHostnames: false,
      } : {}),
    };

    console.log('🔧 Connection options:', {
      tls: mongoOptions.tls,
      serverSelectionTimeoutMS: mongoOptions.serverSelectionTimeoutMS,
    });

    await mongoose.connect(config.mongoUri, mongoOptions);
    isMongoConnected = true;

    // Indexes must never take the API offline
    try {
      await ensurePerformanceIndexes();
    } catch (idxErr: any) {
      console.warn('⚠️ Index setup skipped:', idxErr?.message || idxErr);
    }

    // Keep the flag accurate across Atlas drops / idle disconnects
    mongoose.connection.on('connected', () => {
      isMongoConnected = true;
      console.log('✅ MongoDB connected event');
    });
    mongoose.connection.on('disconnected', () => {
      isMongoConnected = false;
      console.warn('⚠️ MongoDB disconnected');
    });
    mongoose.connection.on('error', (err) => {
      console.error('❌ MongoDB error:', err?.message || err);
      syncMongoFlag();
    });

    console.log('✅ MongoDB connected successfully');
    console.log(`📊 Database: ${mongoose.connection.name}`);
    console.log(`🔗 Host: ${mongoose.connection.host}`);
    return true;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    if (error instanceof Error) {
      console.error(`🔍 Error details: ${error.message}`);
    }
    console.log('⚠️ Falling back to in-memory storage...');
    isMongoConnected = false;
    return false;
  }
}

// ============================================
// CREATE APP
// ============================================

const app = createApp();

// Security middleware (CORS allow-list + security headers)
app.use(eventHandler(async (event) => {
  await securityMiddleware(event);
}));

app.use(eventHandler((event) => {
  performanceMiddleware(event);
}));

// Health check
app.use('/api/health', eventHandler(() => {
  const connected = mongoose.connection.readyState === 1;
  isMongoConnected = connected;
  return {
    status: connected ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
    database: {
      connected,
      readyState: mongoose.connection.readyState,
      host: mongoose.connection.host || 'not connected',
      name: mongoose.connection.name || 'not connected',
    },
  };
}));

// ============================================
// IN-MEMORY FALLBACK STORAGE
// ============================================

const inMemoryQuotes: any[] = [];
const inMemoryOrders: any[] = [];

// ============================================
// HELPERS
// ============================================

function generateReference(prefix: string = 'UQ'): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = `${prefix}-`;
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateOrderReference(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `ORD-${timestamp}-${random}`;
}

function extractPaymentAmount(replyMessage: string): number | null {
  if (!replyMessage) return null;
  
  const patterns = [
    /R\s*([\d,]+)/i,
    /pay\s*R\s*([\d,]+)/i,
    /amount\s*R\s*([\d,]+)/i,
    /total\s*R\s*([\d,]+)/i,
    /cost\s*R\s*([\d,]+)/i,
    /price\s*R\s*([\d,]+)/i,
    /payment\s*R\s*([\d,]+)/i
  ];
  
  for (const pattern of patterns) {
    const match = replyMessage.match(pattern);
    if (match) {
      const amount = parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(amount) && amount > 0) {
        return amount;
      }
    }
  }
  return null;
}

// ============================================
// TRACK QUOTE API - MUST COME FIRST BEFORE /api/quotes
// ============================================

app.use('/api/quotes/track', eventHandler(async (event) => {
  const limited = rateLimitOrNull(event, 'track');
  if (limited) {
    event.node.res.statusCode = limited.statusCode;
    return limited.body;
  }

  console.log(`🔍 Track quote request received: ${event.method}`);
  
  try {
    const url = new URL(event.node.req.url || '', `http://${event.node.req.headers.host}`);
    const ref = url.searchParams.get('ref');
    const email = url.searchParams.get('email');
    
    console.log(`🔍 ===== TRACK QUOTE REQUEST =====`);
    console.log(`🔍 Reference: ${ref}`);
    console.log(`🔍 Email: ${email}`);
    
    if (!ref || !email) {
      return {
        success: false,
        error: 'Reference and email are required',
        quote: null
      };
    }
    
    const cleanRef = ref.trim().toUpperCase();
    const cleanEmail = email.trim().toLowerCase();
    
    console.log(`🔍 Cleaned Reference: ${cleanRef}`);
    console.log(`🔍 Cleaned Email: ${cleanEmail}`);
    console.log(`🔍 MongoDB connected: ${isMongoConnected}`);
    
    let quote = null;
    
    if (isMongoConnected) {
      console.log(`🔍 Searching MongoDB for quote...`);
      quote = await Quote.findOne({ reference: cleanRef, email: cleanEmail });
      
      if (quote) {
        console.log(`✅ Found exact match: ${quote.reference}`);
      }
    }
    
    if (!quote) {
      quote = inMemoryQuotes.find(q => q.reference === cleanRef && q.email === cleanEmail);
      if (quote) {
        console.log(`✅ Found in-memory match: ${quote.reference}`);
      }
    }
    
    if (!quote) {
      console.log(`❌ Quote NOT FOUND: ${cleanRef} | ${cleanEmail}`);
      return {
        success: false,
        error: 'Quote not found. Check your reference and email.',
        quote: null
      };
    }
    
    console.log(`✅ ===== QUOTE FOUND =====`);
    console.log(`✅ Reference: ${quote.reference}`);
    console.log(`✅ Customer: ${quote.customerName}`);
    console.log(`✅ Status: ${quote.status}`);
    console.log(`✅ Items: ${quote.items.length}`);
    
    let paymentRequired = quote.paymentRequired || false;
    let paymentAmount = quote.paymentAmount || 0;
    
    if (!paymentRequired && quote.replyMessage) {
      const extractedAmount = extractPaymentAmount(quote.replyMessage);
      if (extractedAmount) {
        paymentRequired = true;
        paymentAmount = extractedAmount;
        console.log(`💰 Auto-extracted payment amount: R${extractedAmount}`);
      }
    }
    
    const addr =
      (quote as any).address ||
      (quote as any).delivery_address ||
      '';
    const dDate =
      (quote as any).delivery_date ||
      (quote as any).preferred_delivery_date ||
      '';

    return {
      success: true,
      quote: {
        id: quote._id?.toString() || `mem_${Date.now()}`,
        reference: quote.reference,
        customerName: quote.customerName,
        company: (quote as any).company || '',
        email: quote.email,
        phone: quote.phone,
        address: addr,
        delivery_address: addr,
        delivery_date: dDate,
        preferred_delivery_date: dDate,
        site_notes: (quote as any).site_notes || '',
        delivery: (quote as any).delivery || null,
        status: quote.status,
        items: quote.items.map((item: any) => ({
          id: item.id,
          name: item.name,
          qty: item.qty,
          image: item.image || null,
          price: item.price != null ? item.price : null,
          note: item.note || undefined,
        })),
        replyMessage: quote.replyMessage || null,
        repliedAt: quote.repliedAt || null,
        createdAt: quote.createdAt,
        paymentRequired: paymentRequired,
        paymentAmount: paymentAmount,
        quotation_total: (quote as any).quotation_total || paymentAmount || 0,
        paymentStatus: quote.paymentStatus || 'pending',
        feedback: quote.feedback || null
      }
    };
  } catch (error) {
    console.error('❌ Error tracking quote:', error);
    return {
      success: false,
      error: 'Failed to track quote',
      quote: null
    };
  }
}));

// ============================================
// QUOTE STATUS + DIRECTOR REVIEW handlers
// Dispatched from the working broad mounts (no h3 :param routes).
// ============================================

function extractQuoteReferenceFromUrl(rawUrl: string): string {
  const pathname = String(rawUrl || '').split('?')[0];
  const m =
    pathname.match(/\/api\/(?:admin\/)?quotes\/([^/]+)/i) ||
    pathname.match(/\/([^/]+)\/(?:status|director-review)/i);
  return m ? decodeURIComponent(m[1]).trim().toUpperCase() : '';
}

async function handleQuoteStatusUpdate(event: any) {
  if (!['POST', 'PUT', 'PATCH'].includes(String(event.method || '').toUpperCase())) {
    event.node.res.statusCode = 405;
    return { success: false, message: 'Method not allowed' };
  }
  try {
    const rawUrl = String(event.node.req.url || '');
    const reference = extractQuoteReferenceFromUrl(rawUrl);
    const body = (await readBody(event).catch(() => ({}))) || {};

    console.log(`🔄 STATUS UPDATE: ref=${reference} method=${event.method} url=${rawUrl}`, body);

    if (!reference) {
      event.node.res.statusCode = 400;
      return { success: false, message: 'Reference is required', error: 'Missing required fields' };
    }

    const status = body.status ?? body.newStatus ?? body.quoteStatus;
    if (!status) {
      event.node.res.statusCode = 400;
      return { success: false, message: 'Status is required', error: 'Missing required fields' };
    }

    if (!isMongoConnected) {
      event.node.res.statusCode = 503;
      return { success: false, message: 'Database unavailable' };
    }

    const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let quote: any = await Quote.findOne({ reference });
    if (!quote) {
      quote = await Quote.findOne({ reference: { $regex: `^${escaped}$`, $options: 'i' } });
    }
    if (!quote) {
      event.node.res.statusCode = 404;
      return { success: false, message: 'Quote not found' };
    }

    const previous = quote.status;
    quote.status = status;
    quote.updatedAt = new Date();
    if (String(status).toLowerCase() === 'accepted') {
      (quote as any).accepted_at = new Date();
      (quote as any).accepted_by = body.by || body.username || null;
    }
    if (String(status).toLowerCase() === 'completed') {
      (quote as any).completed_at = new Date();
      (quote as any).completed_by = body.by || body.username || null;
    }
    if (!Array.isArray((quote as any).history)) (quote as any).history = [];
    (quote as any).history.push({
      action: 'status_change',
      from: previous,
      to: status,
      by: body.by || body.username || 'api',
      time: new Date().toISOString(),
    });
    await quote.save();
    console.log(`✅ Status updated for ${reference}: ${previous} → ${status}`);

    return {
      success: true,
      message: `Status updated to ${status}`,
      quote: { reference: quote.reference, status: quote.status },
    };
  } catch (error) {
    console.error('❌ Error updating status:', error);
    event.node.res.statusCode = 500;
    return { success: false, message: 'Failed to update status' };
  }
}

async function handleDirectorReviewRequest(event: any) {
  if (String(event.method || '').toUpperCase() !== 'POST') {
    event.node.res.statusCode = 405;
    return { success: false, message: 'Method not allowed' };
  }
  try {
    const rawUrl = String(event.node.req.url || '');
    const reference = extractQuoteReferenceFromUrl(rawUrl);
    const body = (await readBody(event).catch(() => ({}))) || {};

    console.log(`📨 DIRECTOR REVIEW REQUEST: ref=${reference} url=${rawUrl}`, body);

    if (!reference) {
      event.node.res.statusCode = 400;
      return { success: false, message: 'Reference is required' };
    }
    if (!isMongoConnected) {
      event.node.res.statusCode = 503;
      return { success: false, message: 'Database unavailable' };
    }

    const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let quote: any = await Quote.findOne({ reference });
    if (!quote) {
      quote = await Quote.findOne({ reference: { $regex: `^${escaped}$`, $options: 'i' } });
    }
    if (!quote) {
      event.node.res.statusCode = 404;
      return { success: false, message: 'Quote not found' };
    }

    const previous = quote.status;
    // Desktop Quote Management expects:
    //   status: "in_review" (display "In Review")
    //   director_review.status: "pending"
    //   director_review.requested_by: { username, full_name }
    //   director_review.items: per-line availability slots
    const requestedBy = {
      username: body.username || body.by || null,
      full_name: body.full_name || body.by || body.username || null,
    };
    const items = Array.isArray(quote.items) ? quote.items : [];
    const reviewItems = items.map((it: any) => ({
      item_id: String(it?.id || it?._id || ''),
      item_name: it?.name || 'Item',
      qty_requested: it?.qty ?? 1,
      availability: '',
      comment: '',
    }));

    const review = {
      status: 'pending',
      requested_at: new Date().toISOString(),
      requested_by: requestedBy,
      reviewed_at: null,
      director: null,
      general_reply: '',
      note: body.note || body.message || null,
      items: reviewItems,
    };

    // Keep both camelCase (mongoose schema) and snake_case for clients
    (quote as any).directorReview = review;
    (quote as any).director_review = review;
    quote.status = body.status || 'in_review';
    quote.updatedAt = new Date();
    if (!Array.isArray((quote as any).history)) (quote as any).history = [];
    (quote as any).history.push({
      action: 'sent_to_director',
      from: previous,
      to: quote.status,
      by: body.by || body.username || 'api',
      time: new Date().toISOString(),
      note: 'Sent to Director for availability check',
    });
    await quote.save();
    console.log(`✅ Director review requested for ${reference}: ${previous} → ${quote.status}`);

    return {
      success: true,
      message: 'Director review requested',
      quote: {
        reference: quote.reference,
        status: quote.status,
        director_review: review,
      },
    };
  } catch (error) {
    console.error('❌ director-review/request error:', error);
    event.node.res.statusCode = 500;
    return { success: false, message: 'Failed to request director review' };
  }
}

async function handleDirectorReviewSubmit(event: any) {
  if (!['PUT', 'POST', 'PATCH'].includes(String(event.method || '').toUpperCase())) {
    event.node.res.statusCode = 405;
    return { success: false, message: 'Method not allowed' };
  }
  try {
    const rawUrl = String(event.node.req.url || '');
    const reference = extractQuoteReferenceFromUrl(rawUrl);
    const body = (await readBody(event).catch(() => ({}))) || {};

    console.log(`📨 DIRECTOR REVIEW SUBMIT: ref=${reference} url=${rawUrl}`, body);

    if (!reference) {
      event.node.res.statusCode = 400;
      return { success: false, message: 'Reference is required' };
    }
    if (!isMongoConnected) {
      event.node.res.statusCode = 503;
      return { success: false, message: 'Database unavailable' };
    }

    const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let quote: any = await Quote.findOne({ reference });
    if (!quote) {
      quote = await Quote.findOne({ reference: { $regex: `^${escaped}$`, $options: 'i' } });
    }
    if (!quote) {
      event.node.res.statusCode = 404;
      return { success: false, message: 'Quote not found' };
    }

    const previous = quote.status;
    const existing =
      (quote as any).director_review ||
      (quote as any).directorReview ||
      {};

    const director = {
      username: body.username || null,
      full_name: body.full_name || body.by || body.username || 'Director',
    };

    const review = {
      ...existing,
      status: body.reviewStatus || 'reviewed',
      reviewed_at: new Date().toISOString(),
      director,
      general_reply:
        body.general_reply ||
        body.generalReply ||
        body.reply ||
        body.message ||
        existing.general_reply ||
        '',
      items: body.items || body.availability || existing.items || [],
    };

    if (body.status) quote.status = body.status;
    else if (!body.status && previous === 'in_review') {
      // leave in_review so employee can continue after director replies
      quote.status = previous;
    }

    (quote as any).directorReview = review;
    (quote as any).director_review = review;
    if (body.replyMessage) {
      quote.replyMessage = body.replyMessage;
      quote.repliedAt = new Date();
    }
    quote.updatedAt = new Date();
    if (!Array.isArray((quote as any).history)) (quote as any).history = [];
    (quote as any).history.push({
      action: 'director_review_submitted',
      from: previous,
      to: quote.status,
      by: body.by || body.username || 'api',
      time: new Date().toISOString(),
      note: 'Director submitted availability review',
    });
    await quote.save();
    console.log(`✅ Director review submitted for ${reference}`);

    return {
      success: true,
      message: 'Director review submitted',
      quote: {
        reference: quote.reference,
        status: quote.status,
        director_review: review,
      },
    };
  } catch (error) {
    console.error('❌ director-review error:', error);
    event.node.res.statusCode = 500;
    return { success: false, message: 'Failed to submit director review' };
  }
}

// ============================================
// QUOTES API - POST and GET
// ============================================

app.use('/api/quotes', eventHandler(async (event) => {
  const limited = rateLimitOrNull(event, 'write');
  if (limited) {
    event.node.res.statusCode = limited.statusCode;
    return limited.body;
  }

  
  
  // Public status alias: /api/quotes/:ref/status (desktop fallback)
  {
    const rawUrl = String(event.node.req.url || '');
    const pathname = rawUrl.split('?')[0];
    const isStatus =
      /\/(?:api\/)?quotes\/[^/]+\/status\/?$/i.test(pathname) ||
      /^\/[^/]+\/status\/?$/i.test(pathname);
    if (isStatus) {
      return await handleQuoteStatusUpdate(event);
    }
    // Ignore other sub-paths that have their own routes (assignment etc.)
    const isOtherSub =
      /\/(?:api\/)?quotes\/[^/]+\//i.test(pathname) ||
      /^\/[^/]+\/(assignment|assign|feedback)/i.test(pathname);
    if (isOtherSub) {
      return;
    }
  }

console.log(`📋 Quotes request received: ${event.method}`);
  
  // Handle POST - Create quote
  if (event.method === 'POST') {
    try {
      const body = await readBody(event);
      console.log('📥 Quote received:', JSON.stringify(body, null, 2));
      
      const {
        customerName,
        company,
        email,
        phone,
        notes,
        items,
        address,
        delivery_address,
        delivery_date,
        preferred_delivery_date,
        site_notes,
      } = body;
      
      if (!customerName || !email || !phone || !items || items.length === 0) {
        return { success: false, error: 'Missing required fields' };
      }
      
      const reference = generateReference('UQ');
      console.log(`🔑 Generated reference: ${reference}`);

      const resolvedAddress = String(address || delivery_address || '').trim();
      const resolvedDeliveryDate = String(
        delivery_date || preferred_delivery_date || ''
      ).trim();
      const resolvedSiteNotes = String(site_notes || '').trim();
      
      const quoteData = {
        reference,
        customerName,
        company: company || '',
        email: email.toLowerCase().trim(),
        phone,
        notes: notes || '',
        // Persist client delivery / site details
        address: resolvedAddress,
        delivery_address: resolvedAddress,
        delivery_date: resolvedDeliveryDate,
        preferred_delivery_date: resolvedDeliveryDate,
        site_notes: resolvedSiteNotes,
        delivery: resolvedAddress
          ? {
              address: resolvedAddress,
              date: resolvedDeliveryDate || undefined,
              status: 'pending',
            }
          : undefined,
        items: items.map((item: any) => ({
          id: item.id,
          name: item.name,
          kind: item.kind || 'product',
          qty: item.qty,
          image: item.image || null,
          price: item.price != null ? Number(item.price) : undefined,
          specs: Array.isArray(item.specs) ? item.specs : undefined,
          note: item.note || undefined,
        })),
        status: 'received',
        paymentRequired: false,
        paymentAmount: 0,
        paymentStatus: 'pending',
        feedback: { submitted: false }
      };
      
      let savedQuote;
      
      if (isMongoConnected) {
        try {
          const quote = new Quote(quoteData);
          savedQuote = await quote.save();
          console.log(`✅ Quote SAVED TO MONGODB with reference: ${reference}`);
        } catch (dbError) {
          console.error('❌ Failed to save to MongoDB:', dbError);
          savedQuote = { ...quoteData, _id: `mem_${Date.now()}` };
          inMemoryQuotes.push(savedQuote);
          console.log(`💾 Quote saved in-memory: ${reference}`);
        }
      } else {
        savedQuote = { ...quoteData, _id: `mem_${Date.now()}` };
        inMemoryQuotes.push(savedQuote);
        console.log(`💾 Quote saved in-memory: ${reference}`);
      }
      
      return { success: true, reference: savedQuote.reference };
    } catch (error) {
      console.error('❌ Error:', error);
      return { success: false, error: 'Failed to process quote' };
    }
  }
  
  // Handle GET - List all quotes
  if (event.method === 'GET') {
    try {
      let quotes = [];
      if (isMongoConnected) {
        quotes = await Quote.find({}).sort({ createdAt: -1 }).limit(50).lean();
        console.log(`📋 Found ${quotes.length} quotes in MongoDB`);
      } else {
        quotes = inMemoryQuotes;
        console.log(`📋 Found ${quotes.length} quotes in memory`);
      }
      
      return {
        success: true,
        count: quotes.length,
        quotes: quotes.map(q => {
          let review =
            (q as any).director_review ||
            (q as any).directorReview ||
            null;
          // Backfill for quotes stuck on awaiting_director without a review object
          if (!review && String(q.status || '').toLowerCase() === 'awaiting_director') {
            const items = Array.isArray(q.items) ? q.items : [];
            review = {
              status: 'pending',
              requested_at: q.updatedAt || q.createdAt || new Date().toISOString(),
              requested_by: { username: null, full_name: 'Employee' },
              reviewed_at: null,
              director: null,
              general_reply: '',
              items: items.map((it: any) => ({
                item_id: String(it?.id || it?._id || ''),
                item_name: it?.name || 'Item',
                qty_requested: it?.qty ?? 1,
                availability: '',
                comment: '',
              })),
            };
          }
          return {
            reference: q.reference,
            customerName: q.customerName,
            company: q.company || '',
            email: q.email,
            phone: q.phone || '',
            notes: q.notes || '',
            // Delivery / site (website form + ops desktop)
            address: (q as any).address || (q as any).delivery_address || '',
            delivery_address: (q as any).delivery_address || (q as any).address || '',
            delivery_date: (q as any).delivery_date || (q as any).preferred_delivery_date || '',
            preferred_delivery_date: (q as any).preferred_delivery_date || (q as any).delivery_date || '',
            site_notes: (q as any).site_notes || '',
            delivery: (q as any).delivery || null,
            quotation: (q as any).quotation || [],
            quotation_total: (q as any).quotation_total || q.paymentAmount || 0,
            status: q.status,
            createdAt: q.createdAt,
            updatedAt: (q as any).updatedAt || q.createdAt,
            items: q.items,
            paymentRequired: q.paymentRequired || false,
            paymentAmount: q.paymentAmount || 0,
            paymentStatus: q.paymentStatus || 'pending',
            feedback: q.feedback || { submitted: false },
            replyMessage: q.replyMessage || null,
            assigned_to: q.assigned_to || null,
            assigned_by: q.assigned_by || null,
            history: (q as any).history || [],
            // Desktop expects snake_case director_review with status "pending"
            director_review: review,
            directorReview: review,
          };
        })
      };
    } catch (error) {
      console.error('❌ Error fetching quotes:', error);
      return { success: false, error: 'Failed to fetch quotes' };
    }
  }
  
  return { success: false, error: 'Method not allowed' };
}));

// ============================================
// TRACK ORDER API - MUST COME BEFORE /api/orders
// ============================================

app.use('/api/orders/track', eventHandler(async (event) => {
  console.log(`🔍 Track order request received: ${event.method}`);
  
  try {
    const url = new URL(event.node.req.url || '', `http://${event.node.req.headers.host}`);
    const ref = url.searchParams.get('ref');
    const email = url.searchParams.get('email');
    
    console.log(`🔍 ===== TRACK ORDER REQUEST =====`);
    console.log(`🔍 Method: ${event.method}`);
    console.log(`🔍 Reference: ${ref}`);
    console.log(`🔍 Email: ${email}`);
    
    if (!ref || !email) {
      return {
        success: false,
        error: 'Reference and email are required',
        order: null
      };
    }
    
    const cleanRef = ref.trim().toUpperCase();
    const cleanEmail = email.trim().toLowerCase();
    
    console.log(`🔍 Cleaned Reference: ${cleanRef}`);
    console.log(`🔍 Cleaned Email: ${cleanEmail}`);
    console.log(`🔍 MongoDB connected: ${isMongoConnected}`);
    
    let order = null;
    
    if (isMongoConnected) {
      console.log(`🔍 Searching MongoDB for order...`);
      
      order = await Order.findOne({ 
        reference: cleanRef, 
        email: cleanEmail 
      });
      
      if (order) {
        console.log(`✅ Found order: ${order.reference}`);
      }
      
      if (!order) {
        console.log(`🔍 Trying search by reference only...`);
        order = await Order.findOne({ reference: cleanRef });
        if (order) {
          console.log(`✅ Found by reference: ${order.reference}`);
        }
      }
      
      if (!order) {
        console.log(`🔍 Trying case insensitive search...`);
        order = await Order.findOne({ 
          reference: { $regex: new RegExp(`^${cleanRef}$`, 'i') }
        });
        if (order) {
          console.log(`✅ Found case insensitive: ${order.reference}`);
        }
      }
    }
    
    if (!order) {
      order = inMemoryOrders.find(o => o.reference === cleanRef);
      if (order) {
        console.log(`✅ Found in-memory match: ${order.reference}`);
      }
    }
    
    if (!order) {
      console.log(`❌ Order NOT FOUND: ${cleanRef} | ${cleanEmail}`);
      return {
        success: false,
        error: 'Order not found. Check your reference and email.',
        order: null
      };
    }
    
    console.log(`✅ ===== ORDER FOUND =====`);
    console.log(`✅ Reference: ${order.reference}`);
    console.log(`✅ Customer: ${order.customerName}`);
    console.log(`✅ Status: ${order.status}`);
    console.log(`✅ Total: R${order.total}`);
    
    return {
      success: true,
      order: {
        reference: order.reference,
        customerName: order.customerName,
        email: order.email,
        phone: order.phone,
        address: order.address,
        notes: order.notes || '',
        status: order.status,
        items: order.items.map((item: any) => ({
          id: item.id,
          name: item.name,
          qty: item.qty,
          price: item.price,
        })),
        total: order.total,
        trackingNumber: order.trackingNumber || null,
        carrier: order.carrier || null,
        estimatedDelivery: order.estimatedDelivery || null,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt || order.createdAt,
      }
    };
  } catch (error) {
    console.error('❌ Error tracking order:', error);
    return {
      success: false,
      error: 'Failed to track order',
      order: null
    };
  }
}));

// ============================================
// ORDERS API - POST and GET
// ============================================

app.use('/api/orders', eventHandler(async (event) => {
  const limited = rateLimitOrNull(event, 'write');
  if (limited) {
    event.node.res.statusCode = limited.statusCode;
    return limited.body;
  }

  console.log(`📋 Orders request received: ${event.method}`);
  
  // Handle GET - List all orders
  if (event.method === 'GET') {
    try {
      console.log('📋 Fetching all orders...');
      let orders = [];
      
      if (isMongoConnected) {
        orders = await Order.find({}).sort({ createdAt: -1 }).limit(50).lean();
        console.log(`📋 Found ${orders.length} orders in MongoDB`);
      } else {
        orders = inMemoryOrders;
        console.log(`📋 Found ${orders.length} orders in memory`);
      }
      
      return {
        success: true,
        count: orders.length,
        orders: orders.map(o => ({
          reference: o.reference,
          customerName: o.customerName,
          company: o.company || '',
          email: o.email,
          phone: o.phone || '',
          address: o.address || '',
          notes: o.notes || '',
          status: o.status,
          total: o.total,
          createdAt: o.createdAt,
          updatedAt: o.updatedAt || o.createdAt,
          items: o.items,
          trackingNumber: o.trackingNumber || null,
          carrier: o.carrier || null,
          assigned_to: o.assigned_to || null,
          assigned_by: o.assigned_by || null
        }))
      };
    } catch (error) {
      console.error('❌ Error fetching orders:', error);
      return {
        success: false,
        error: 'Failed to fetch orders'
      };
    }
  }
  
  // Handle POST - Create new order
  if (event.method === 'POST') {
    try {
      const body = await readBody(event);
      console.log('📥 Order received:', JSON.stringify(body, null, 2));
      
      const { customerName, company, email, phone, address, notes, items, total } = body;
      
      if (!customerName || !email || !phone || !address || !items || items.length === 0) {
        return { success: false, error: 'Missing required fields' };
      }
      
      const reference = generateOrderReference();
      
      const orderData = {
        reference,
        customerName,
        company: company || '',
        email: email.toLowerCase().trim(),
        phone,
        address,
        notes: notes || '',
        items: items.map((item: any) => ({
          id: item.id,
          name: item.name,
          qty: item.qty,
          price: item.price || 0
        })),
        total: total || 0,
        status: 'pending'
      };
      
      let savedOrder;
      
      if (isMongoConnected) {
        try {
          const order = new Order(orderData);
          savedOrder = await order.save();
          console.log(`✅ Order SAVED TO MONGODB with Reference: ${reference}`);
        } catch (dbError) {
          console.error('❌ Failed to save to MongoDB:', dbError);
          savedOrder = { ...orderData, _id: `mem_${Date.now()}` };
          inMemoryOrders.push(savedOrder);
          console.log(`💾 Order saved in-memory: ${reference}`);
        }
      } else {
        savedOrder = { ...orderData, _id: `mem_${Date.now()}` };
        inMemoryOrders.push(savedOrder);
        console.log(`💾 Order saved in-memory: ${reference}`);
      }
      
      return {
        success: true,
        orderId: savedOrder._id,
        orderReference: savedOrder.reference
      };
    } catch (error) {
      console.error('❌ Error:', error);
      return { success: false, error: 'Failed to process order' };
    }
  }
  
  return {
    success: false,
    error: `Method ${event.method} not allowed for /api/orders`
  };
}));

// ============================================
// PAYMENT API - Initiate Payment
// ============================================

app.use('/api/quotes/payment', eventHandler(async (event) => {
  if (event.method === 'POST') {
    try {
      const body = await readBody(event);
      const { reference, email } = body;
      
      console.log(`💳 Payment initiated for: ${reference}`);
      
      if (!reference || !email) {
        return {
          success: false,
          message: 'Reference and email are required'
        };
      }
      
      let quote = null;
      
      if (isMongoConnected) {
        quote = await Quote.findOne({ 
          reference: reference.toUpperCase(), 
          email: email.toLowerCase() 
        });
        
        if (!quote) {
          return {
            success: false,
            message: 'Quote not found'
          };
        }
        
        if (!quote.paymentRequired || !quote.paymentAmount) {
          const extractedAmount = extractPaymentAmount(quote.replyMessage || '');
          if (extractedAmount) {
            quote.paymentRequired = true;
            quote.paymentAmount = extractedAmount;
            await quote.save();
          } else {
            return {
              success: false,
              message: 'No payment required for this quote'
            };
          }
        }
        
        const paymentRef = `PAY-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        quote.paymentReference = paymentRef;
        quote.paymentStatus = 'pending';
        quote.status = 'payment';
        await quote.save();
        
        const paymentUrl = `${config.frontendUrl}/payment/${paymentRef}`;
        
        return {
          success: true,
          message: 'Payment initiated',
          paymentUrl: paymentUrl,
          quote: {
            id: quote._id.toString(),
            reference: quote.reference,
            customerName: quote.customerName,
            email: quote.email,
            phone: quote.phone,
            status: quote.status,
            items: quote.items.map((item: any) => ({
              id: item.id,
              name: item.name,
              qty: item.qty,
              image: item.image || null
            })),
            replyMessage: quote.replyMessage || null,
            repliedAt: quote.repliedAt || null,
            createdAt: quote.createdAt,
            paymentRequired: quote.paymentRequired || false,
            paymentAmount: quote.paymentAmount || 0,
            paymentStatus: quote.paymentStatus || 'pending',
            feedback: quote.feedback || null
          }
        };
      }
      
      return {
        success: false,
        message: 'Payment service unavailable'
      };
    } catch (error) {
      console.error('❌ Error initiating payment:', error);
      return {
        success: false,
        message: 'Failed to initiate payment'
      };
    }
  }
  
  return { success: false, message: 'Method not allowed' };
}));

// ============================================
// PAYMENT WEBHOOK
// ============================================

app.use('/api/payment/webhook', eventHandler(async (event) => {
  if (event.method === 'POST') {
    try {
      const body = await readBody(event);
      console.log('📥 Payment webhook received:', JSON.stringify(body, null, 2));
      
      const { paymentReference, status } = body;
      
      if (!paymentReference) {
        return {
          success: false,
          message: 'Payment reference is required'
        };
      }
      
      let quote = null;
      
      if (isMongoConnected) {
        quote = await Quote.findOne({ paymentReference });
        
        if (quote) {
          if (status === 'completed' || status === 'paid') {
            quote.paymentStatus = 'paid';
            quote.status = 'payment';
          } else if (status === 'failed' || status === 'cancelled') {
            quote.paymentStatus = 'failed';
            quote.status = 'quoted';
          }
          
          await quote.save();
          console.log(`✅ Payment status updated for ${quote.reference}: ${quote.paymentStatus}`);
        }
      }
      
      return {
        success: true,
        message: 'Webhook processed successfully'
      };
    } catch (error) {
      console.error('❌ Error processing webhook:', error);
      return {
        success: false,
        message: 'Failed to process webhook'
      };
    }
  }
  
  return { success: false, message: 'Method not allowed' };
}));

// ============================================
// SIMULATE PAYMENT COMPLETION
// ============================================

app.use('/api/payment/simulate/:reference', eventHandler(async (event) => {
  if (event.method === 'POST') {
    try {
      const reference = event.context.params?.reference;
      
      console.log(`🔄 Simulating payment completion for: ${reference}`);
      
      if (!reference) {
        return {
          success: false,
          message: 'Reference is required'
        };
      }
      
      let quote = null;
      
      if (isMongoConnected) {
        quote = await Quote.findOne({ reference: reference.toUpperCase() });
        
        if (!quote) {
          return {
            success: false,
            message: 'Quote not found'
          };
        }
        
        quote.paymentStatus = 'paid';
        quote.status = 'payment';
        await quote.save();
        
        console.log(`✅ Payment simulated for ${reference}: PAID`);
      }
      
      return {
        success: true,
        message: 'Payment simulated successfully',
        quote: quote ? {
          reference: quote.reference,
          paymentStatus: quote.paymentStatus,
          status: quote.status
        } : null
      };
    } catch (error) {
      console.error('❌ Error simulating payment:', error);
      return {
        success: false,
        message: 'Failed to simulate payment'
      };
    }
  }
  
  return { success: false, message: 'Method not allowed' };
}));

// ============================================
// FEEDBACK API
// ============================================

app.use('/api/quotes/feedback', eventHandler(async (event) => {
  if (event.method === 'POST') {
    try {
      const body = await readBody(event);
      const { reference, email, feedback } = body;
      
      console.log(`📝 Feedback received for: ${reference}`);
      console.log(`📊 Rating: ${feedback.rating}`);
      console.log(`💬 Comment: ${feedback.comment}`);
      
      if (!reference || !email || !feedback) {
        return {
          success: false,
          message: 'Missing required fields'
        };
      }
      
      let quote = null;
      
      if (isMongoConnected) {
        quote = await Quote.findOne({ 
          reference: reference.toUpperCase(), 
          email: email.toLowerCase() 
        });
        
        if (quote) {
          quote.feedback = {
            rating: feedback.rating,
            comment: feedback.comment,
            submitted: true,
            submittedAt: new Date()
          };
          
          if (feedback.rating >= 4) {
            quote.status = 'approved';
          } else {
            quote.status = 'waiting_feedback';
          }
          
          await quote.save();
          console.log(`✅ Feedback saved for ${reference}`);
        }
      }
      
      if (!quote) {
        return {
          success: false,
          message: 'Quote not found'
        };
      }
      
      return {
        success: true,
        message: 'Feedback submitted successfully',
        quote: {
          id: quote._id.toString(),
          reference: quote.reference,
          customerName: quote.customerName,
          email: quote.email,
          phone: quote.phone,
          status: quote.status,
          items: quote.items.map((item: any) => ({
            id: item.id,
            name: item.name,
            qty: item.qty,
            image: item.image || null
          })),
          replyMessage: quote.replyMessage || null,
          repliedAt: quote.repliedAt || null,
          createdAt: quote.createdAt,
          paymentRequired: quote.paymentRequired || false,
          paymentAmount: quote.paymentAmount || 0,
          paymentStatus: quote.paymentStatus || 'pending',
          feedback: quote.feedback || null
        }
      };
    } catch (error) {
      console.error('❌ Error submitting feedback:', error);
      return {
        success: false,
        message: 'Failed to submit feedback'
      };
    }
  }
  
  return { success: false, message: 'Method not allowed' };
}));

// ============================================
// DESKTOP MANAGEMENT API - EMPLOYEES + ASSIGNMENTS
// ============================================

const MANAGEMENT_ROLES = new Set([
  'director', 'branch manager', 'business lead', 'operations manager',
  'manager', 'admin', 'administrator', 'super admin'
]);

function isManagementUser(user: any, employee: any): boolean {
  const role = normaliseLogin(user?.role || employee?.role || '');
  return MANAGEMENT_ROLES.has(role);
}

function safeEmployeePayload(employee: any, user: any = null) {
  const fullName = employeeDisplayName(employee, user);
  return {
    id: employee?._id?.toString?.() ?? employee?._id ?? employee?.id ?? null,
    employee_id: employee?.employee_id ?? employee?.id ?? employee?._id?.toString?.() ?? null,
    full_name: fullName,
    first_name: employee?.first_name || '',
    last_name: employee?.last_name || employee?.surname || '',
    email: employee?.email || employee?.email_address || user?.email || '',
    username: user?.username || user?.email || employee?.username || employee?.email || '',
    role: employee?.role || user?.role || 'Staff',
    department: employee?.department || user?.department || '',
    position: employee?.position || user?.position || '',
    status: employee?.status || user?.status || 'Active',
  };
}

async function requireManagementSession(event: any) {
  const session = await requireDesktopSession(event);
  if (!isManagementUser(session.user, session.employee)) {
    const error = new Error('Manager permission is required for this operation.');
    (error as any).statusCode = 403;
    throw error;
  }
  return session;
}

app.use('/api/employees', eventHandler(async (event) => {
  if (event.method !== 'GET') {
    event.node.res.statusCode = 405;
    return { success: false, error: 'Method not allowed' };
  }
  try {
    const { db, user } = await requireDesktopSession(event);
    const employees = await db.collection('employees').find({}).sort({ full_name: 1, first_name: 1, surname: 1 }).limit(500).toArray();
    const userDocs = await db.collection('users').find({}).project({ password: 0, password_hash: 0, hashed_password: 0 }).limit(2000).toArray();
    const usersByEmployee = new Map<string, any>();
    const usersByEmail = new Map<string, any>();
    for (const u of userDocs) {
      if (u.employee_id !== undefined && u.employee_id !== null) usersByEmployee.set(String(u.employee_id), u);
      const email = normaliseLogin(u.email || u.username);
      if (email) usersByEmail.set(email, u);
    }
    const safeEmployees = employees
      .filter((employee: any) => isActive(employee.status, true))
      .map((employee: any) => {
        const employeeKeys = [employee._id?.toString?.(), employee.employee_id, employee.id].filter(Boolean).map(String);
        const linked = employeeKeys.map(k => usersByEmployee.get(k)).find(Boolean)
          || usersByEmail.get(normaliseLogin(employee.email || employee.email_address));
        return safeEmployeePayload(employee, linked);
      });
    return { success: true, count: safeEmployees.length, employees: safeEmployees };
  } catch (error: any) {
    event.node.res.statusCode = error?.statusCode || 500;
    return { success: false, error: error?.message || 'Failed to load employees' };
  }
}));



function safeAdminUserPayload(user: any, employee: any = null) {
  const fullName = employeeDisplayName(employee, user);
  return {
    id: user?._id?.toString?.() ?? user?._id ?? null,
    employee_id: user?.employee_id?.toString?.() ?? employee?.employee_id?.toString?.() ?? employee?._id?.toString?.() ?? null,
    username: user?.username || user?.email || '',
    email: user?.email || employee?.email || employee?.email_address || '',
    role: user?.role || employee?.role || 'Staff',
    status: user?.status || 'active',
    full_name: fullName,
    first_name: employee?.first_name || '',
    surname: employee?.surname || employee?.last_name || '',
    department: user?.department || employee?.department || '',
    position: user?.position || employee?.position || '',
    last_login_at: user?.last_login_at || null,
    created_at: user?.created_at || null,
    updated_at: user?.updated_at || null,
    has_account: true,
  };
}

async function findEmployeeByReference(db: any, reference: unknown) {
  const value = String(reference ?? '').trim();
  if (!value) return null;

  const employees = db.collection('employees');

  // First try the normal indexed fields.
  const clauses: any[] = [{ employee_id: value }, { id: value }];
  const oid = safeObjectId(value);
  if (oid) clauses.push({ _id: oid });

  // If employee_id is stored as a number/ObjectId in MongoDB, also try a
  // numeric representation where applicable.
  if (/^-?\\d+$/.test(value)) {
    const numericValue = Number(value);
    if (Number.isSafeInteger(numericValue)) {
      clauses.push({ employee_id: numericValue }, { id: numericValue });
    }
  }

  let employee = await employees.findOne({ $or: clauses });
  if (employee) return employee;

  // Final compatibility fallback: compare the string representation of the
  // common employee identifiers. This handles old records where the same
  // employee ID was stored with a different BSON type.
  const candidates = await employees.find({}).limit(5000).toArray();
  const wanted = value.toLowerCase();

  employee = candidates.find((item: any) => {
    const values = [
      item?.employee_id,
      item?.id,
      item?._id?.toString?.(),
      item?._id,
      item?.user_id,
      item?.username,
      item?.email,
    ].filter(v => v !== undefined && v !== null);

    return values.some(v => String(v).trim().toLowerCase() === wanted);
  }) || null;

  return employee;
}

async function findUserByReference(db: any, reference: unknown) {
  const value = String(reference ?? '').trim();
  if (!value) return null;
  const clauses: any[] = [{ username: value }, { email: value }];
  const oid = safeObjectId(value);
  if (oid) clauses.push({ _id: oid });
  return db.collection('users').findOne({ $or: clauses });
}

function hashPbkdf2Sha256(password: string): string {
  const iterations = 310_000;
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), Buffer.from(salt, 'utf8'), iterations, 32, 'sha256').toString('hex');
  return `pbkdf2_sha256$${iterations}$${salt}$${digest}`;
}

app.use('/api/admin/employees', eventHandler(async (event) => {
  if (event.method !== 'GET') { event.node.res.statusCode = 405; return { success: false, error: 'Method not allowed' }; }
  try {
    const { db } = await requireManagementSession(event);
    const employees = await db.collection('employees').find({}).sort({ full_name: 1, first_name: 1, surname: 1 }).limit(2000).toArray();
    const users = await db.collection('users').find({}).project({ password: 0, password_hash: 0, hashed_password: 0 }).limit(5000).toArray();
    const byEmployee = new Map<string, any>();
    const byEmail = new Map<string, any>();
    for (const user of users) {
      if (user.employee_id !== undefined && user.employee_id !== null) byEmployee.set(String(user.employee_id), user);
      const email = normaliseLogin(user.email || user.username);
      if (email) byEmail.set(email, user);
    }
    const result = employees.map((employee: any) => {
      const keys = [employee.employee_id, employee.id, employee._id?.toString?.()].filter(Boolean).map(String);
      const linked = keys.map(k => byEmployee.get(k)).find(Boolean) || byEmail.get(normaliseLogin(employee.email || employee.email_address));
      const payload = safeEmployeePayload(employee, linked);
      return {
        ...payload,
        _id: payload.id,
        mongo_id: payload.id,
        has_account: !!linked,
        user_id: linked?._id?.toString?.() ?? linked?._id ?? null,
        last_login_at: linked?.last_login_at || null,
      };
    });
    return { success: true, count: result.length, employees: result };
  } catch (error: any) {
    event.node.res.statusCode = error?.statusCode || 500;
    return { success: false, error: error?.message || 'Failed to load employees' };
  }
}));

app.use('/api/admin/users', eventHandler(async (event) => {
  try {
    const { db } = await requireManagementSession(event);
    if (event.method === 'GET') {
      const users = await db.collection('users').find({}).project({ password: 0, password_hash: 0, hashed_password: 0 }).sort({ username: 1 }).limit(5000).toArray();
      const employees = await db.collection('employees').find({}).limit(5000).toArray();
      const byEmployee = new Map<string, any>();
      const byEmail = new Map<string, any>();
      for (const employee of employees) {
        for (const key of [employee.employee_id, employee.id, employee._id?.toString?.()].filter(Boolean)) byEmployee.set(String(key), employee);
        const email = normaliseLogin(employee.email || employee.email_address);
        if (email) byEmail.set(email, employee);
      }
      const result = users.map((user: any) => {
        const employee = byEmployee.get(String(user.employee_id ?? '')) || byEmail.get(normaliseLogin(user.email || user.username));
        return safeAdminUserPayload(user, employee);
      });
      return { success: true, count: result.length, users: result };
    }

    if (event.method === 'POST') {
      const body = await readBody(event);
      const employee = await findEmployeeByReference(db, body?.employee_id);
      if (!employee) { event.node.res.statusCode = 404; return { success: false, error: 'Employee not found.' }; }
      const username = normaliseLogin(body?.username);
      const password = String(body?.password ?? '');
      if (!username || !password) { event.node.res.statusCode = 400; return { success: false, error: 'Username and password are required.' }; }
      if (password.length < 8) { event.node.res.statusCode = 400; return { success: false, error: 'Password must be at least 8 characters.' }; }
      const existingUsername = await findUserByReference(db, username);
      if (existingUsername) { event.node.res.statusCode = 409; return { success: false, error: `Username '${username}' is already in use.` }; }
      const employeeKeys = [employee.employee_id, employee.id, employee._id].filter(v => v !== undefined && v !== null);
      const existingEmployeeAccount = await db.collection('users').findOne({ employee_id: { $in: employeeKeys } });
      if (existingEmployeeAccount) { event.node.res.statusCode = 409; return { success: false, error: 'This employee already has a user account.', code: 'ACCOUNT_EXISTS' }; }
      const now = new Date();
      const doc: any = {
        employee_id: employee.employee_id ?? employee.id ?? employee._id,
        username,
        email: body?.email || employee.email || employee.email_address || username,
        role: String(body?.role || 'Staff'),
        status: body?.active === false ? 'inactive' : 'active',
        password_hash: hashPbkdf2Sha256(password),
        require_password_change: !!body?.require_password_change,
        created_at: now,
        updated_at: now,
      };
      const inserted = await db.collection('users').insertOne(doc);
      const created = await db.collection('users').findOne({ _id: inserted.insertedId }, { projection: { password: 0, password_hash: 0, hashed_password: 0 } });
      return { success: true, user: safeAdminUserPayload(created, employee) };
    }

    event.node.res.statusCode = 405;
    return { success: false, error: 'Method not allowed' };
  } catch (error: any) {
    event.node.res.statusCode = error?.statusCode || 500;
    return { success: false, error: error?.message || 'User administration failed.' };
  }
}));

app.use('/api/admin/users/:id/reset-password', eventHandler(async (event) => {
  if (event.method !== 'POST') { event.node.res.statusCode = 405; return { success: false, error: 'Method not allowed' }; }
  try {
    const { db } = await requireManagementSession(event);
    const id = String(event.context.params?.id || '').trim();
    const oid = safeObjectId(id);
    if (!oid) { event.node.res.statusCode = 404; return { success: false, error: 'User not found.' }; }
    const target = await db.collection('users').findOne({ _id: oid });
    if (!target) { event.node.res.statusCode = 404; return { success: false, error: 'User not found.' }; }
    const body = await readBody(event);
    const password = String(body?.password ?? '');
    if (password.length < 8) { event.node.res.statusCode = 400; return { success: false, error: 'Password must be at least 8 characters.' }; }
    await db.collection('users').updateOne({ _id: oid }, { $set: { password_hash: hashPbkdf2Sha256(password), updated_at: new Date(), require_password_change: true } });
    const updated = await db.collection('users').findOne({ _id: oid }, { projection: { password: 0, password_hash: 0, hashed_password: 0 } });
    const employee = await findEmployeeByReference(db, updated?.employee_id);
    return { success: true, user: safeAdminUserPayload(updated, employee) };
  } catch (error: any) {
    event.node.res.statusCode = error?.statusCode || 500;
    return { success: false, error: error?.message || 'Password reset failed.' };
  }
}));

app.use('/api/admin/users/:id', eventHandler(async (event) => {
  try {
    const { db, user: actor } = await requireManagementSession(event);
    const id = String(event.context.params?.id || '').trim();
    const oid = safeObjectId(id);
    if (!oid) { event.node.res.statusCode = 404; return { success: false, error: 'User not found.' }; }
    const target = await db.collection('users').findOne({ _id: oid });
    if (!target) { event.node.res.statusCode = 404; return { success: false, error: 'User not found.' }; }

    if (event.method === 'PUT') {
      const body = await readBody(event);
      const update: any = { updated_at: new Date() };
      if (body?.username !== undefined) {
        const username = normaliseLogin(body.username);
        if (!username) { event.node.res.statusCode = 400; return { success: false, error: 'Username cannot be empty.' }; }
        const owner = await db.collection('users').findOne({ username, _id: { $ne: oid } });
        if (owner) { event.node.res.statusCode = 409; return { success: false, error: `Username '${username}' is already in use.` }; }
        update.username = username;
      }
      if (body?.role !== undefined) update.role = String(body.role || 'Staff');
      if (body?.active !== undefined) update.status = body.active ? 'active' : 'inactive';
      if (body?.employee_id !== undefined) {
        const employee = await findEmployeeByReference(db, body.employee_id);
        if (!employee) { event.node.res.statusCode = 404; return { success: false, error: 'Employee not found.' }; }
        update.employee_id = employee.employee_id ?? employee.id ?? employee._id;
        update.email = employee.email || employee.email_address || target.email || update.username || target.username;
      }
      if (body?.password) {
        const password = String(body.password);
        if (password.length < 8) { event.node.res.statusCode = 400; return { success: false, error: 'Password must be at least 8 characters.' }; }
        update.password_hash = hashPbkdf2Sha256(password);
        update.require_password_change = !!body?.require_password_change;
      }
      await db.collection('users').updateOne({ _id: oid }, { $set: update });
      const updated = await db.collection('users').findOne({ _id: oid }, { projection: { password: 0, password_hash: 0, hashed_password: 0 } });
      const employee = await findEmployeeByReference(db, updated?.employee_id);
      return { success: true, user: safeAdminUserPayload(updated, employee) };
    }

    if (event.method === 'POST' && event.context.params?.id && event.node.req.url?.includes('/reset-password')) {
      const body = await readBody(event);
      const password = String(body?.password ?? '');
      if (password.length < 8) { event.node.res.statusCode = 400; return { success: false, error: 'Password must be at least 8 characters.' }; }
      await db.collection('users').updateOne({ _id: oid }, { $set: { password_hash: hashPbkdf2Sha256(password), updated_at: new Date(), require_password_change: true } });
      const updated = await db.collection('users').findOne({ _id: oid }, { projection: { password: 0, password_hash: 0, hashed_password: 0 } });
      const employee = await findEmployeeByReference(db, updated?.employee_id);
      return { success: true, user: safeAdminUserPayload(updated, employee) };
    }

    if (event.method === 'DELETE') {
      if (String(actor?._id) === id) { event.node.res.statusCode = 400; return { success: false, error: 'You cannot delete your own account while logged in.' }; }
      await db.collection('users').deleteOne({ _id: oid });
      return { success: true, message: 'User deleted.' };
    }

    event.node.res.statusCode = 405;
    return { success: false, error: 'Method not allowed' };
  } catch (error: any) {
    event.node.res.statusCode = error?.statusCode || 500;
    return { success: false, error: error?.message || 'User administration failed.' };
  }
}));

async function handleQuoteAssignment(event: any) {
  const { db, user } = await requireManagementSession(event);
  const reference = String(event.context.params?.reference || '').trim().toUpperCase();
  const body = await readBody(event);

  if (!reference) {
    event.node.res.statusCode = 400;
    return { success: false, error: 'Reference is required' };
  }

  // Accept every payload shape used by the desktop clients.
  const requested = body?.employee_id ?? body?.employeeId ?? body?.assigned_to ?? body?.assignedTo ?? null;
  let assignedTo: any = null;

  if (requested !== null && requested !== undefined && String(requested).trim() !== '') {
    const employee = await findEmployeeByReference(db, requested);
    if (!employee || !isActive(employee.status, true)) {
      console.error(`❌ Assignment failed: employee not found: ${requested}`);
      return { success: false, error: 'Employee not found or inactive' };
    }

    const linkedUser = await db.collection('users').findOne({ $or: [
      { employee_id: employee.employee_id },
      { employee_id: employee._id },
      ...(employee.email ? [{ email: employee.email }] : []),
    ] });

    assignedTo = safeEmployeePayload(employee, linkedUser);
  }

  const actor = {
    id: user._id?.toString?.() ?? user._id,
    username: user.username || user.email || '',
    full_name: user.full_name || user.username || user.email || '',
  };

  console.log(`👤 Assignment request: quote=${reference} employee=${requested ?? 'UNASSIGN'} method=${event.method} url=${event.node.req.url}`);

  if (isMongoConnected) {
    const quote = await Quote.findOne({
      $or: [
        { reference },
        { reference: { $regex: `^${reference.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}$`, $options: 'i' } },
      ],
    });

    if (!quote) {
      console.error(`❌ Assignment failed: quote not found: ${reference}`);
      return { success: false, error: 'Quote not found' };
    }

    quote.assigned_to = assignedTo;
    quote.assigned_by = assignedTo ? actor : null;
    if (assignedTo) quote.status = 'assigned';
    await quote.save();

    console.log(`✅ Quote ${quote.reference} assigned to ${assignedTo?.employee_id || assignedTo?.id || 'UNASSIGNED'}`);
    return {
      success: true,
      message: assignedTo ? 'Quote assigned successfully.' : 'Quote unassigned successfully.',
      quote: {
        reference: quote.reference,
        assigned_to: quote.assigned_to,
        assigned_by: quote.assigned_by,
        status: quote.status,
      },
    };
  }

  const quote = inMemoryQuotes.find(q => String(q.reference).toUpperCase() === reference);
  if (!quote) {
    event.node.res.statusCode = 404;
    return { success: false, error: 'Quote not found' };
  }
  quote.assigned_to = assignedTo;
  quote.assigned_by = assignedTo ? actor : null;
  if (assignedTo) quote.status = 'assigned';
  return { success: true, message: 'Quote assigned successfully.', quote };
}

// ============================================================
// UNIVERSAL DESKTOP QUOTE ASSIGNMENT DISPATCHER
// ============================================================
// The Windows desktop client historically used more than one assignment
// URL.  Handle the request at the /api/admin/quotes level and inspect the
// actual URL so a router parameter mismatch cannot produce a false 404.
// This handler is registered BEFORE the generic /api/admin/quotes/:reference
// update handler below.
//
// Supported examples:
//   PUT/POST/PATCH /api/admin/quotes/UQ-XXXXXX/assignment
//   PUT/POST/PATCH /api/admin/quotes/UQ-XXXXXX/assign
//   PUT/POST/PATCH /api/admin/quotes/UQ-XXXXXX/assign-employee
//   PUT/POST/PATCH /api/admin/quotes/UQ-XXXXXX/assignment/employee
// ============================================================

app.use('/api/admin/quotes', eventHandler(async (event) => {

  // ---- Status + Director Review (handle HERE; do not fall through) ----
  {
    const rawUrl = String(event.node.req.url || '');
    const pathname = rawUrl.split('?')[0];
    const isStatus =
      /\/(?:api\/)?admin\/quotes\/[^/]+\/status\/?$/i.test(pathname) ||
      /\/[^/]+\/status\/?$/i.test(pathname);
    const isDirectorRequest =
      /\/director-review\/request\/?$/i.test(pathname);
    const isDirectorSubmit =
      !isDirectorRequest && /\/director-review\/?$/i.test(pathname);

    if (isStatus) {
      return await handleQuoteStatusUpdate(event);
    }
    if (isDirectorRequest) {
      return await handleDirectorReviewRequest(event);
    }
    if (isDirectorSubmit) {
      return await handleDirectorReviewSubmit(event);
    }
  }
  // ---- end status/director dispatch ----


  
  const method = String(event.method || '').toUpperCase();
  const rawUrl = String(event.node.req.url || '');
  // h3 may strip the mount prefix, so path can be either:
  //   /api/admin/quotes/UQ-XXX/assignment
  //   /UQ-XXX/assignment
  const pathname = rawUrl.split('?')[0];

  const match =
    pathname.match(
      /^\/api\/admin\/quotes\/([^/]+)\/(assignment|assign|assign-employee|assign_employee|assignment\/employee)\/?$/
    ) ||
    pathname.match(
      /^\/([^/]+)\/(assignment|assign|assign-employee|assign_employee|assignment\/employee)\/?$/
    );

  // Not an assignment request: let the normal quote handlers continue.
  if (!match) return;

  console.log(`🚨 ASSIGNMENT ENDPOINT HIT: ${method} ${rawUrl}`);

  if (!['PUT', 'POST', 'PATCH'].includes(method)) {
    event.node.res.statusCode = 405;
    return {
      success: false,
      error: 'Method not allowed for quote assignment',
      endpoint: pathname,
    };
  }

  try {
    // Do not rely on event.context.params here. Extract the reference directly
    // from the actual URL so this works even when h3 mounted middleware does
    // not populate dynamic params.
    const reference = decodeURIComponent(match[1]).trim().toUpperCase();
    const body = await readBody(event);
    const { db, user } = await requireManagementSession(event);

    const requested =
      body?.employee_id ??
      body?.employeeId ??
      body?.assigned_to ??
      body?.assignedTo ??
      body?.employee ??
      body?.employeeID ??
      null;

    console.log(
      `👤 ASSIGNMENT REQUEST: quote=${reference} employee=${requested ?? 'UNASSIGN'} method=${method} url=${rawUrl}`
    );

    let assignedTo: any = null;

    if (requested !== null && requested !== undefined && String(requested).trim() !== '') {
      const employee = await findEmployeeByReference(db, requested);

      if (!employee) {
        // Return a normal JSON response instead of an HTTP 404 so the desktop
        // client can display the actual reason instead of "Backend returned HTTP 404".
        console.error(`❌ ASSIGNMENT EMPLOYEE NOT FOUND: ${String(requested)}`);
        return {
          success: false,
          error: `Employee not found: ${String(requested)}`,
          code: 'EMPLOYEE_NOT_FOUND',
        };
      }

      if (!isActive(employee.status, true)) {
        console.error(`❌ ASSIGNMENT EMPLOYEE INACTIVE: ${String(requested)}`);
        return {
          success: false,
          error: `Employee is inactive: ${employeeDisplayName(employee)}`,
          code: 'EMPLOYEE_INACTIVE',
        };
      }

      const linkedUser = await db.collection('users').findOne({
        $or: [
          { employee_id: employee.employee_id },
          { employee_id: employee._id },
          ...(employee.email ? [{ email: employee.email }] : []),
        ],
      });

      assignedTo = safeEmployeePayload(employee, linkedUser);

      console.log(
        `👤 ASSIGNMENT EMPLOYEE FOUND: employee_id=${assignedTo.employee_id} name=${assignedTo.full_name}`
      );
    }

    // Quote lookup is deliberately case-insensitive and whitespace-tolerant.
    let quote: any = null;

    if (isMongoConnected) {
      const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&');

      quote = await Quote.findOne({
        $or: [
          { reference },
          { reference: { $regex: `^${escaped}$`, $options: 'i' } },
        ],
      });

      if (!quote) {
        // Last-resort collection lookup for legacy documents.
        const rawQuote = await db.collection('quotes').findOne({
          reference: { $regex: `^${escaped}$`, $options: 'i' },
        });

        if (rawQuote) {
          quote = await Quote.findById(rawQuote._id);
        }
      }
    } else {
      quote = inMemoryQuotes.find(
        (q: any) => String(q?.reference || '').trim().toUpperCase() === reference
      );
    }

    if (!quote) {
      // Again, keep business-level failures as JSON instead of HTTP 404.
      console.error(`❌ ASSIGNMENT QUOTE NOT FOUND: ${reference}`);
      return {
        success: false,
        error: `Quote not found: ${reference}`,
        code: 'QUOTE_NOT_FOUND',
      };
    }

    const actor = {
      id: user?._id?.toString?.() ?? user?._id ?? null,
      username: user?.username || user?.email || '',
      full_name: user?.full_name || user?.username || user?.email || '',
    };

    quote.assigned_to = assignedTo;
    quote.assigned_by = assignedTo ? actor : null;

    if (assignedTo) {
      quote.status = 'assigned';
    }

    if (isMongoConnected) {
      quote.updatedAt = new Date();
      await quote.save();
    }

    console.log(
      `✅ ASSIGNMENT SUCCESS: quote=${reference} employee=${assignedTo?.employee_id || assignedTo?.id || 'UNASSIGNED'} status=${quote.status}`
    );

    return {
      success: true,
      message: assignedTo
        ? 'Quote assigned successfully.'
        : 'Quote unassigned successfully.',
      quote: {
        reference: quote.reference,
        assigned_to: quote.assigned_to,
        assigned_by: quote.assigned_by,
        status: quote.status,
      },
    };
  } catch (error: any) {
    const status = error?.statusCode || 500;
    console.error(
      `❌ ASSIGNMENT EXCEPTION [${method} ${rawUrl}] HTTP ${status}:`,
      error?.stack || error?.message || error
    );

    event.node.res.statusCode = status;

    return {
      success: false,
      error: error?.message || 'Quote assignment failed.',
      code: 'ASSIGNMENT_EXCEPTION',
    };
  }
}));

// Compatibility routes: older/newer desktop builds used different assignment URLs.
for (const path of [
  '/api/admin/quotes/:reference/assignment',
  '/api/admin/quotes/:reference/assign',
  '/api/quotes/:reference/assignment',
  '/api/quotes/:reference/assign',
]) {
  app.use(path, eventHandler(async (event) => {
    // Support both PUT and POST so the backend cannot 404/405 solely because
    // the desktop build uses the other assignment convention.
    if (event.method !== 'PUT' && event.method !== 'POST') {
      event.node.res.statusCode = 405;
      return { success: false, error: 'Method not allowed' };
    }
    try {
      return await handleQuoteAssignment(event);
    } catch (error: any) {
      event.node.res.statusCode = error?.statusCode || 500;
      console.error(`❌ Quote assignment error [${event.method} ${event.node.req.url}]:`, error?.message || error);
      return { success: false, error: error?.message || 'Failed to assign quote' };
    }
  }));
}

async function handleOrderAssignment(event: any) {
  const { db, user } = await requireManagementSession(event);
  const reference = String(event.context.params?.reference || '').trim().toUpperCase();
  const body = await readBody(event);
  if (!reference) { event.node.res.statusCode = 400; return { success: false, error: 'Reference is required' }; }

  const requested = body?.employee_id ?? body?.employeeId ?? body?.assigned_to ?? body?.assignedTo ?? null;
  let assignedTo: any = null;
  if (requested !== null && requested !== undefined && String(requested).trim() !== '') {
    const employee = await findEmployeeByReference(db, requested);
    if (!employee || !isActive(employee.status, true)) { event.node.res.statusCode = 404; return { success: false, error: 'Employee not found or inactive' }; }
    const linkedUser = await db.collection('users').findOne({ $or: [
      { employee_id: employee.employee_id }, { employee_id: employee._id }, ...(employee.email ? [{ email: employee.email }] : [])
    ] });
    assignedTo = safeEmployeePayload(employee, linkedUser);
  }

  const actor = { id: user._id?.toString?.() ?? user._id, username: user.username || user.email || '', full_name: user.full_name || user.username || user.email || '' };
  const order = isMongoConnected ? await Order.findOne({ reference }) : inMemoryOrders.find(o => String(o.reference).toUpperCase() === reference);
  if (!order) { event.node.res.statusCode = 404; return { success: false, error: 'Order not found' }; }
  order.assigned_to = assignedTo;
  order.assigned_by = assignedTo ? actor : null;
  if (assignedTo && String(order.status || '').toLowerCase() === 'pending') order.status = 'assigned';
  order.updatedAt = new Date();
  if (isMongoConnected) await order.save();
  return { success: true, message: assignedTo ? 'Order assigned successfully.' : 'Order unassigned successfully.', order: { reference: order.reference, assigned_to: order.assigned_to, assigned_by: order.assigned_by, status: order.status } };
}

for (const path of [
  '/api/admin/orders/:reference/assignment',
  '/api/admin/orders/:reference/assign',
  '/api/orders/:reference/assignment',
  '/api/orders/:reference/assign',
]) {
  app.use(path, eventHandler(async (event) => {
    if (event.method !== 'PUT' && event.method !== 'POST') { event.node.res.statusCode = 405; return { success: false, error: 'Method not allowed' }; }
    try { return await handleOrderAssignment(event); }
    catch (error: any) { event.node.res.statusCode = error?.statusCode || 500; console.error(`❌ Order assignment error [${event.method} ${event.node.req.url}]:`, error?.message || error); return { success: false, error: error?.message || 'Failed to assign order' }; }
  }));
}

// ============================================
// ADMIN API - Update Quote
// ============================================

app.use('/api/admin/quotes/:reference', eventHandler(async (event) => {
  if (event.method === 'PUT') {
    try {
      const reference = event.context.params?.reference;
      const body = await readBody(event);
      
      console.log(`🔧 Updating quote: ${reference}`);
      
      if (!reference) {
        return { success: false, message: 'Reference is required' };
      }
      
      let quote = null;
      
      if (isMongoConnected) {
        quote = await Quote.findOne({ reference: reference.toUpperCase() });
        
        if (!quote) {
          return { success: false, message: 'Quote not found' };
        }
        
        if (body.status) quote.status = body.status;
        if (body.replyMessage) {
          quote.replyMessage = body.replyMessage;
          quote.repliedAt = new Date();
          
          const extractedAmount = extractPaymentAmount(body.replyMessage);
          if (extractedAmount) {
            quote.paymentRequired = true;
            quote.paymentAmount = extractedAmount;
            quote.paymentStatus = 'pending';
            console.log(`💰 Auto-extracted payment amount: R${extractedAmount} from reply`);
          }
        }
        if (body.repliedAt) quote.repliedAt = new Date(body.repliedAt);
        if (body.paymentRequired !== undefined) quote.paymentRequired = body.paymentRequired;
        if (body.paymentAmount !== undefined) quote.paymentAmount = body.paymentAmount;
        if (body.paymentStatus) quote.paymentStatus = body.paymentStatus;
        if (body.items) quote.items = body.items;
        
        await quote.save();
        console.log(`✅ Quote updated: ${reference}`);
      }
      
      return {
        success: true,
        message: 'Quote updated successfully',
        quote: quote ? {
          reference: quote.reference,
          status: quote.status,
          replyMessage: quote.replyMessage,
          paymentRequired: quote.paymentRequired,
          paymentAmount: quote.paymentAmount,
          paymentStatus: quote.paymentStatus,
          items: quote.items
        } : null
      };
    } catch (error) {
      console.error('❌ Error updating quote:', error);
      return { success: false, message: 'Failed to update quote' };
    }
  }
  
  return { success: false, message: 'Method not allowed' };
}));

// ============================================
// ADMIN API - Set Payment for Quote
// ============================================

app.use('/api/admin/quotes/:reference/payment', eventHandler(async (event) => {
  if (event.method === 'POST') {
    try {
      const reference = event.context.params?.reference;
      const body = await readBody(event);
      
      console.log(`💳 Setting payment for: ${reference}`);
      
      if (!reference) {
        return { success: false, message: 'Reference is required' };
      }
      
      const { amount } = body;
      
      if (!amount || amount <= 0) {
        return { success: false, message: 'Valid payment amount is required' };
      }
      
      let quote = null;
      
      if (isMongoConnected) {
        quote = await Quote.findOne({ reference: reference.toUpperCase() });
        
        if (!quote) {
          return { success: false, message: 'Quote not found' };
        }
        
        quote.paymentRequired = true;
        quote.paymentAmount = amount;
        quote.paymentStatus = 'pending';
        
        await quote.save();
        console.log(`✅ Payment set for ${reference}: R${amount}`);
      }
      
      return {
        success: true,
        message: `Payment of R${amount} set for quote ${reference}`,
        quote: quote ? {
          reference: quote.reference,
          paymentRequired: quote.paymentRequired,
          paymentAmount: quote.paymentAmount,
          paymentStatus: quote.paymentStatus
        } : null
      };
    } catch (error) {
      console.error('❌ Error setting payment:', error);
      return { success: false, message: 'Failed to set payment' };
    }
  }
  
  return { success: false, message: 'Method not allowed' };
}));

// ============================================
// ADMIN API - Extract Payment from Reply
// ============================================

app.use('/api/admin/quotes/:reference/extract-payment', eventHandler(async (event) => {
  if (event.method === 'POST') {
    try {
      const reference = event.context.params?.reference;
      
      console.log(`💰 Extracting payment for: ${reference}`);
      
      if (!reference) {
        return { success: false, message: 'Reference is required' };
      }
      
      let quote = null;
      
      if (isMongoConnected) {
        quote = await Quote.findOne({ reference: reference.toUpperCase() });
        
        if (!quote) {
          return { success: false, message: 'Quote not found' };
        }
        
        const amount = extractPaymentAmount(quote.replyMessage || '');
        
        if (amount) {
          quote.paymentRequired = true;
          quote.paymentAmount = amount;
          quote.paymentStatus = 'pending';
          await quote.save();
          
          return {
            success: true,
            message: `Payment extracted: R${amount}`,
            quote: {
              reference: quote.reference,
              paymentRequired: quote.paymentRequired,
              paymentAmount: quote.paymentAmount,
              paymentStatus: quote.paymentStatus
            }
          };
        }
        
        return { success: false, message: 'No payment amount found in reply message' };
      }
      
      return { success: false, message: 'Database not connected' };
    } catch (error) {
      console.error('❌ Error extracting payment:', error);
      return { success: false, message: 'Failed to extract payment' };
    }
  }
  
  return { success: false, message: 'Method not allowed' };
}));

// ============================================
// ADMIN API - Force Update Quote Status
// ============================================

// Order status updates (desktop uses PATCH /api/orders/status with body)
app.use('/api/orders/status', eventHandler(async (event) => {
  if (!['PATCH', 'POST', 'PUT'].includes(event.method || '')) {
    event.node.res.statusCode = 405;
    return { success: false, message: 'Method not allowed for /api/orders' };
  }
  try {
    const body = await readBody(event) || {};
    const reference = typeof body?.reference === 'string' ? body.reference.trim().toUpperCase() : '';
    const status = typeof body?.status === 'string' ? body.status.trim().toLowerCase() : '';
    if (!reference || !status) {
      event.node.res.statusCode = 400;
      return { success: false, message: 'Reference and status are required' };
    }
    const allowed = new Set(['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'received', 'in_progress', 'completed']);
    if (!allowed.has(status)) {
      event.node.res.statusCode = 400;
      return { success: false, message: 'Invalid order status' };
    }
    if (!isMongoConnected) {
      event.node.res.statusCode = 503;
      return { success: false, message: 'Database unavailable' };
    }
    const update: Record<string, unknown> = { status, updatedAt: new Date() };
    if (body.trackingNumber !== undefined) update.trackingNumber = body.trackingNumber || null;
    if (body.carrier !== undefined) update.carrier = body.carrier || null;
    const order = await Order.findOneAndUpdate(
      { reference },
      { $set: update },
      { new: true }
    );
    if (!order) {
      event.node.res.statusCode = 404;
      return { success: false, message: 'Order not found' };
    }
    return {
      success: true,
      message: 'Order status updated',
      order: {
        reference: order.reference,
        status: order.status,
        trackingNumber: (order as any).trackingNumber || null,
        carrier: (order as any).carrier || null,
      },
    };
  } catch (error) {
    console.error('❌ Order status update error:', error);
    event.node.res.statusCode = 500;
    return { success: false, message: 'Failed to update order status' };
  }
}));


// ============================================
// DESKTOP EXE API - AUTHENTICATION + ATTENDANCE
// ============================================
// The Windows EXE talks to these endpoints instead of connecting directly
// to MongoDB. MongoDB credentials therefore remain on the server.

const ACTIVE_STATUS_VALUES = new Set(['active', 'enabled', 'approved', 'true', '1', 'yes']);
const SESSION_HOURS = 8;

function normaliseLogin(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function isActive(value: unknown, defaultValue = true): boolean {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === 'boolean') return value;
  return ACTIVE_STATUS_VALUES.has(String(value).trim().toLowerCase());
}

function mongoRequired() {
  if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
    isMongoConnected = true;
    return mongoose.connection.db;
  }
  isMongoConnected = false;
  const error = new Error(
    'MongoDB is unavailable. The API is starting up or the database is offline. Please wait a few seconds and try again.'
  );
  (error as any).statusCode = 503;
  throw error;
}

function safeObjectId(value: unknown): any {
  if (value === undefined || value === null) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  const text = String(value);
  return mongoose.isValidObjectId(text) ? new mongoose.Types.ObjectId(text) : null;
}

function employeeReferenceValues(value: any): any[] {
  const values: any[] = [];
  if (value !== undefined && value !== null) values.push(value);
  if (value instanceof mongoose.Types.ObjectId) values.push(value.toString());
  else if (typeof value === 'string') {
    const oid = safeObjectId(value);
    if (oid) values.push(oid);
  }
  return values.filter((v, i, a) => a.findIndex(x => String(x) === String(v)) === i);
}

async function findEmployeeForUser(user: any) {
  const db = mongoRequired();
  const employees = db.collection('employees');
  const employeeId = user?.employee_id;

  if (employeeId !== undefined && employeeId !== null) {
    const refs = employeeReferenceValues(employeeId);
    if (refs.length) {
      const employee = await employees.findOne({
        $or: [
          { _id: { $in: refs.filter(v => v instanceof mongoose.Types.ObjectId) } },
          { employee_id: { $in: refs } },
          { id: { $in: refs } },
        ],
      });
      if (employee) return employee;
    }
  }

  const email = normaliseLogin(user?.email || user?.username);
  if (email) {
    return employees.findOne({
      $or: [
        { email: { $regex: `^${email.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}$`, $options: 'i' } },
        { email_address: { $regex: `^${email.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}$`, $options: 'i' } },
      ],
    });
  }
  return null;
}

function verifyPbkdf2Sha256(password: string, stored: string): boolean {
  try {
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
    const iterations = Number(parts[1]);
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 5_000_000) return false;
    const derived = crypto.pbkdf2Sync(
      Buffer.from(password, 'utf8'),
      Buffer.from(parts[2], 'utf8'),
      iterations,
      32,
      'sha256',
    ).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(derived), Buffer.from(parts[3]));
  } catch {
    return false;
  }
}

function verifyPassword(password: string, storedHash: unknown): boolean {
  if (typeof storedHash !== 'string' || !storedHash) return false;
  if (storedHash.startsWith('pbkdf2_sha256$')) return verifyPbkdf2Sha256(password, storedHash);
  if (/^[a-f0-9]{64}$/i.test(storedHash)) {
    const digest = crypto.createHash('sha256').update(password, 'utf8').digest('hex');
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(storedHash));
  }
  // Werkzeug's pbkdf2/scrypt and bcrypt are intentionally rejected unless the
  // backend is built with the corresponding verifier. This prevents accepting
  // plaintext passwords or silently changing password semantics.
  return false;
}

function makeToken(): string {
  return `${randomUUID().replace(/-/g, '')}.${crypto.randomBytes(32).toString('hex')}`;
}

function bearerToken(event: any): string | null {
  const header = String(event.node.req.headers.authorization || '');
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

function todaySouthAfrica(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Johannesburg',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function asDate(value: any): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function elapsedSeconds(start: any, end: any = new Date()): number {
  const a = asDate(start);
  const b = asDate(end);
  if (!a || !b) return 0;
  return Math.max(0, (b.getTime() - a.getTime()) / 1000);
}

function netElapsedSeconds(record: any, end: Date = new Date()): number {
  if (!record?.clock_in_at) return 0;
  const total = elapsedSeconds(record.clock_in_at, end);
  const fixedPause = (Number(record.break_duration_minutes) || 0) + (Number(record.lunch_duration_minutes) || 0);
  const activeBreak = record.break_started_at ? elapsedSeconds(record.break_started_at, end) / 60 : 0;
  return Math.max(0, total - (fixedPause + activeBreak) * 60);
}

function serialiseAttendance(record: any) {
  if (!record) return null;
  return {
    ...record,
    _id: record._id?.toString?.() ?? record._id,
    employee_id: record.employee_id?.toString?.() ?? record.employee_id,
  };
}

async function requireDesktopSession(event: any) {
  const token = bearerToken(event);
  if (!token) {
    const error = new Error('Authentication token is required.');
    (error as any).statusCode = 401;
    throw error;
  }

  const db = mongoRequired();
  const session = await db.collection('api_sessions').findOne({
    token,
    status: 'active',
    expires_at: { $gt: new Date() },
  });
  if (!session) {
    const error = new Error('Session expired or invalid. Please log in again.');
    (error as any).statusCode = 401;
    throw error;
  }

  const users = db.collection('users');
  const user = await users.findOne({ _id: session.user_id });
  if (!user || !isActive(user.status, true)) {
    await db.collection('api_sessions').updateOne({ _id: session._id }, { $set: { status: 'revoked', revoked_at: new Date() } });
    const error = new Error('Your user account is inactive.');
    (error as any).statusCode = 403;
    throw error;
  }

  const employee = await findEmployeeForUser(user);
  if (!employee || !isActive(employee.status, true)) {
    const error = new Error(!employee ? 'Your account is not linked to an employee record.' : 'Your employee record is inactive.');
    (error as any).statusCode = 403;
    throw error;
  }

  // Do not write to MongoDB on every attendance/status request. Session
  // activity is only refreshed periodically; attendance state itself is
  // refreshed by the explicit status endpoint or state-changing actions.
  const now = Date.now();
  const lastActivity = session.last_activity_at ? new Date(session.last_activity_at).getTime() : 0;
  if (now - lastActivity >= 5 * 60 * 1000) {
    await db.collection('api_sessions').updateOne(
      { _id: session._id },
      { $set: { last_activity_at: new Date(now) } },
    );
  }
  return { db, session, user, employee };
}


/** Close open attendance from previous work days (missed clock-out).
 *  Closes at 18:00 Africa/Johannesburg on that work_date (or now if earlier data missing).
 */
async function autoCloseStaleAttendance(db: any, employeeId: any) {
  const today = todaySouthAfrica();
  const values = employeeReferenceValues(employeeId);
  const open = await db.collection('attendance').find({
    employee_id: { $in: values },
    work_date: { $lt: today },
    clock_in_at: { $exists: true, $nin: [null, ''] },
    $or: [
      { clock_out_at: { $exists: false } },
      { clock_out_at: null },
      { clock_out_at: '' },
    ],
  }).toArray();

  for (const record of open) {
    const workDate = String(record.work_date || '').slice(0, 10);
    // Default end-of-day 18:00 SAST = 16:00 UTC
    let end = new Date(`${workDate}T16:00:00.000Z`);
    const clockIn = record.clock_in_at ? new Date(record.clock_in_at) : null;
    if (clockIn && end.getTime() <= clockIn.getTime()) {
      end = new Date(clockIn.getTime() + 8 * 3600 * 1000); // at least 8h after clock-in
    }
    const hours = Math.round((netElapsedSeconds(record, end) / 3600) * 100) / 100;
    await db.collection('attendance').updateOne(
      { _id: record._id },
      {
        $set: {
          clock_out_at: end,
          hours_worked: hours,
          status: 'clocked_out',
          auto_closed: true,
          updated_at: new Date(),
        },
        $unset: { break_started_at: '' },
      },
    );
    console.log(`⏱️ Auto-closed missed clock-out for employee ${employeeId} on ${workDate} (${hours}h)`);
  }
}

async function getTodayAttendance(db: any, employeeId: any) {
  const values = employeeReferenceValues(employeeId);
  return db.collection('attendance').findOne({
    employee_id: { $in: values },
    work_date: todaySouthAfrica(),
  });
}

function employeeDisplayName(employee: any, user: any = null): string {
  return employee?.full_name ||
    [employee?.first_name, employee?.surname || employee?.last_name].filter(Boolean).join(' ') ||
    user?.full_name || user?.username || user?.email || 'Employee';
}

app.use('/api/auth/login', eventHandler(async (event) => {
  const limited = rateLimitOrNull(event, 'auth');
  if (limited) {
    event.node.res.statusCode = limited.statusCode;
    return limited.body;
  }

  if (event.method !== 'POST') return { success: false, error: 'Method not allowed' };
  try {
    const body = await readBody(event);
    const username = normaliseLogin(body?.username || body?.email);
    const password = String(body?.password ?? '');
    if (!username || !password) return { success: false, error: 'Username and password are required.' };

    const db = mongoRequired();
    const users = db.collection('users');
    const user = await users.findOne({
      $or: [
        { username },
        { email: username },
        { username: { $regex: `^${username.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}$`, $options: 'i' } },
        { email: { $regex: `^${username.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}$`, $options: 'i' } },
      ],
    });

    if (!user) return { success: false, error: 'Invalid username or password.' };
    if (!isActive(user.status, true)) return { success: false, error: 'This user account is inactive. Contact a manager.', code: 'USER_INACTIVE' };

    const employee = await findEmployeeForUser(user);
    if (!employee) return { success: false, error: 'Your login account is not linked to an employee record in MongoDB.', code: 'EMPLOYEE_NOT_FOUND' };
    if (!isActive(employee.status, true)) return { success: false, error: 'This employee is inactive and cannot log in. Contact a manager.', code: 'EMPLOYEE_INACTIVE' };

    const storedHash = user.password_hash || user.hashed_password || user.password;
    if (!verifyPassword(password, storedHash)) return { success: false, error: 'Invalid username or password.' };

    const token = makeToken();
    const now = new Date();
    const expires = new Date(now.getTime() + SESSION_HOURS * 60 * 60 * 1000);
    await db.collection('api_sessions').insertOne({
      token,
      user_id: user._id,
      employee_id: employee._id,
      status: 'active',
      created_at: now,
      last_activity_at: now,
      expires_at: expires,
    });

    await users.updateOne({ _id: user._id }, { $set: { last_login_at: now, updated_at: now } });

    return {
      success: true,
      token,
      expires_at: expires.toISOString(),
      user: {
        id: user._id.toString(),
        username: user.username || user.email || username,
        email: user.email || employee.email || '',
        role: user.role || 'Staff',
        status: user.status || 'active',
      },
      employee: {
        id: employee._id.toString(),
        employee_id: employee.employee_id ?? employee.id ?? employee._id.toString(),
        full_name: employeeDisplayName(employee, user),
        email: employee.email || employee.email_address || user.email || '',
        department: employee.department || user.department || '',
        position: employee.position || user.position || '',
        status: employee.status || 'Active',
      },
    };
  } catch (error: any) {
    console.error('Desktop login error:', error?.message || error);
    const status = error?.statusCode || 500;
    event.node.res.statusCode = status;
    return { success: false, error: status === 503 ? 'Authentication service is temporarily unavailable.' : 'Authentication failed.' };
  }
}));

app.use('/api/auth/me', eventHandler(async (event) => {
  try {
    const { user, employee } = await requireDesktopSession(event);
    return {
      success: true,
      user: { id: user._id.toString(), username: user.username || user.email, email: user.email || '' },
      employee: {
        id: employee._id.toString(),
        employee_id: employee.employee_id ?? employee.id ?? employee._id.toString(),
        full_name: employeeDisplayName(employee, user),
        status: employee.status || 'Active',
      },
    };
  } catch (error: any) {
    event.node.res.statusCode = error?.statusCode || 401;
    return { success: false, error: error?.message || 'Unauthorized' };
  }
}));

app.use('/api/auth/logout', eventHandler(async (event) => {
  if (event.method !== 'POST') return { success: false, error: 'Method not allowed' };
  try {
    const token = bearerToken(event);
    if (token && isMongoConnected && mongoose.connection.db) {
      await mongoose.connection.db.collection('api_sessions').updateOne(
        { token },
        { $set: { status: 'logged_out', logout_at: new Date() } },
      );
    }
    return { success: true };
  } catch {
    return { success: true };
  }
}));

async function attendanceAction(event: any, action: string) {
  const { db, employee, user } = await requireDesktopSession(event);
  const collection = db.collection('attendance');
  const employeeId = employee._id;
  const employeeName = employeeDisplayName(employee, user);
  const now = new Date();
  const workDate = todaySouthAfrica();
  let record = await getTodayAttendance(db, employeeId);

  if (action === 'status') {
    await autoCloseStaleAttendance(db, employeeId);
    record = await getTodayAttendance(db, employeeId);
    let state = 'not_started';
    let elapsed = 0;
    if (record?.clock_out_at) {
      state = 'completed';
      elapsed = Number(record.hours_worked || 0) * 3600;
    } else if (record?.break_started_at) {
      state = 'on_break';
      elapsed = netElapsedSeconds(record, now);
    } else if (record?.clock_in_at) {
      state = 'working';
      elapsed = netElapsedSeconds(record, now);
    }
    return {
      success: true,
      server_time: now.toISOString(),
      state,
      status: record?.status || 'not_started',
      elapsed_seconds: Math.round(elapsed * 100) / 100,
      elapsed_hours: Math.round((elapsed / 3600) * 100) / 100,
      clock_in_at: record?.clock_in_at || null,
      clock_out_at: record?.clock_out_at || null,
      break_started_at: record?.break_started_at || null,
      break_duration_minutes: Number(record?.break_duration_minutes || 0),
      record: serialiseAttendance(record),
    };
  }

  if (action === 'clock_in') {
    await autoCloseStaleAttendance(db, employeeId);
    record = await getTodayAttendance(db, employeeId);
    if (record?.clock_in_at && !record?.clock_out_at) throw Object.assign(new Error('Employee is already clocked in.'), { statusCode: 409 });
    if (record?.clock_out_at) throw Object.assign(new Error('Employee has already clocked out today.'), { statusCode: 409 });
    const doc = {
      employee_id: employeeId,
      employee_name: employeeName,
      work_date: workDate,
      clock_in_at: now,
      clock_out_at: null,
      break_started_at: null,
      break_ended_at: null,
      break_duration_minutes: 0,
      lunch_started_at: null,
      lunch_ended_at: null,
      lunch_duration_minutes: 0,
      hours_worked: 0,
      status: 'clocked_in',
      created_at: now,
      updated_at: now,
    };
    if (record) {
      await collection.updateOne({ _id: record._id }, { $set: doc });
      record = { ...record, ...doc };
    } else {
      const inserted = await collection.insertOne(doc);
      record = { ...doc, _id: inserted.insertedId };
    }
    return { success: true, server_time: now.toISOString(), message: 'Clocked in.', record: serialiseAttendance(record) };
  }

  if (action === 'clock_out') {
    if (!record?.clock_in_at) throw Object.assign(new Error('Employee has not clocked in.'), { statusCode: 400 });
    if (record.clock_out_at) throw Object.assign(new Error('Employee has already clocked out.'), { statusCode: 409 });
    if (record.break_started_at) throw Object.assign(new Error('End the active break before clocking out.'), { statusCode: 400 });
    if (record.lunch_started_at && !record.lunch_ended_at) throw Object.assign(new Error('End lunch before clocking out.'), { statusCode: 400 });
    const hours = Math.round((netElapsedSeconds(record, now) / 3600) * 100) / 100;
    const update = { clock_out_at: now, hours_worked: hours, status: 'clocked_out', updated_at: now };
    await collection.updateOne({ _id: record._id }, { $set: update });
    record = { ...record, ...update };
    return { success: true, server_time: now.toISOString(), message: 'Clocked out.', record: serialiseAttendance(record) };
  }

  if (action === 'break_start') {
    if (!record?.clock_in_at) throw Object.assign(new Error('Clock in before starting a break.'), { statusCode: 400 });
    if (record.clock_out_at) throw Object.assign(new Error('Employee has already clocked out.'), { statusCode: 400 });
    if (record.break_started_at) throw Object.assign(new Error('A break is already in progress.'), { statusCode: 409 });
    const update = { break_started_at: now, break_ended_at: null, status: 'on_break', updated_at: now };
    await collection.updateOne({ _id: record._id }, { $set: update });
    record = { ...record, ...update };
    return { success: true, server_time: now.toISOString(), message: 'Break started.', record: serialiseAttendance(record) };
  }

  if (action === 'break_end') {
    if (!record?.break_started_at) throw Object.assign(new Error('No active break was found.'), { statusCode: 400 });
    const extra = elapsedSeconds(record.break_started_at, now) / 60;
    const total = Math.round((Number(record.break_duration_minutes || 0) + extra) * 100) / 100;
    const update = { break_ended_at: now, break_duration_minutes: total, status: 'clocked_in', updated_at: now };
    await collection.updateOne(
      { _id: record._id },
      { $set: update, $unset: { break_started_at: '' } },
    );
    record = { ...record, ...update, break_started_at: null };
    return { success: true, server_time: now.toISOString(), message: 'Break ended.', record: serialiseAttendance(record) };
  }

  throw Object.assign(new Error('Unknown attendance action.'), { statusCode: 400 });
}

for (const [path, action, method] of [
  ['/api/attendance/status', 'status', 'GET'],
  ['/api/attendance/clock-in', 'clock_in', 'POST'],
  ['/api/attendance/clock-out', 'clock_out', 'POST'],
  ['/api/attendance/break/start', 'break_start', 'POST'],
  ['/api/attendance/break/end', 'break_end', 'POST'],
] as const) {
  app.use(path, eventHandler(async (event) => {
    if (event.method !== method) {
      event.node.res.statusCode = 405;
      return { success: false, error: 'Method not allowed' };
    }
    try {
      return await attendanceAction(event, action);
    } catch (error: any) {
      event.node.res.statusCode = error?.statusCode || 500;
      console.error(`Desktop attendance ${action} error:`, error?.message || error);
      return { success: false, error: error?.message || 'Attendance operation failed.' };
    }
  }));
}

app.use('/api/attendance/today', eventHandler(async (event) => {
  try {
    const { db, employee } = await requireDesktopSession(event);
    const record = await getTodayAttendance(db, employee._id);
    return { success: true, attendance: serialiseAttendance(record) };
  } catch (error: any) {
    event.node.res.statusCode = error?.statusCode || 500;
    return { success: false, error: error?.message || 'Unable to read attendance.' };
  }
}));


// ============================================
// DASHBOARD SUMMARY (attendance = Mongo only)
// ============================================

async function dashboardSummary() {
  const db = mongoRequired();
  const today = todaySouthAfrica();
  const attendance = db.collection('attendance');
  const employees = db.collection('employees');
  const tasks = db.collection('work_assignments');
  const approvals = db.collection('approvals');

  // Strict: distinct employees with a real open clock-in TODAY.
  // Never use employees.clocked_in flags.
  const activeAttendanceQuery: any = {
    work_date: today,
    employee_id: { $exists: true, $nin: [null, ''] },
    clock_in_at: { $exists: true, $nin: [null, ''] },
    $and: [
      {
        $or: [
          { clock_out_at: { $exists: false } },
          { clock_out_at: null },
          { clock_out_at: '' },
        ],
      },
      {
        $or: [
          { status: { $in: ['clocked_in', 'on_break', 'Clocked In', 'On Break'] } },
          { status: { $exists: false } },
          { status: null },
          { status: '' },
        ],
      },
    ],
  };

  const activeIds = await attendance.distinct('employee_id', activeAttendanceQuery);
  const peopleWorking = new Set(
    (activeIds || [])
      .filter((id: any) => id !== null && id !== undefined && String(id).trim() !== '')
      .map((id: any) => String(id))
  ).size;

  const [
    totalEmployees,
    activeEmployees,
    tasksDueToday,
    tasksOverdue,
    tasksWaitingReview,
    tasksInProgress,
    pendingTasks,
    pendingApprovals,
  ] = await Promise.all([
    employees.countDocuments({}),
    employees.countDocuments({ status: { $in: ['Active', 'active', 'enabled', 'approved'] } }),
    tasks.countDocuments({
      due_date: { $gte: new Date(`${today}T00:00:00.000Z`), $lt: new Date(`${today}T23:59:59.999Z`) },
      status: { $nin: ['Completed', 'Cancelled', 'Canceled', 'Closed', 'closed', 'Done', 'done'] },
    }),
    tasks.countDocuments({
      due_date: { $lt: new Date() },
      status: { $nin: ['Completed', 'Cancelled', 'Canceled', 'Closed', 'closed', 'Done', 'done'] },
    }),
    tasks.countDocuments({ status: { $in: ['Waiting Review', 'waiting review', 'Waiting for Review', 'waiting_for_review'] } }),
    tasks.countDocuments({ status: { $in: ['In Progress', 'in progress', 'in_progress'] } }),
    tasks.countDocuments({ status: { $in: ['New', 'new', 'Assigned', 'assigned', 'In Progress', 'in progress', 'in_progress', 'Waiting Review', 'waiting review'] } }),
    approvals.countDocuments({ status: { $in: ['Pending', 'pending'] } }),
  ]);

  return {
    success: true,
    people_working: peopleWorking,
    people_on_leave: await employees.countDocuments({ status: { $in: ['On Leave', 'on leave', 'Leave', 'leave'] } }),
    people_on_site: peopleWorking,
    tasks_due_today: tasksDueToday,
    tasks_overdue: tasksOverdue,
    tasks_waiting_review: tasksWaitingReview,
    completed_this_week: 0,
    pending_approvals: pendingApprovals,
    upcoming_deadlines: tasksDueToday,
    latest_activity: [],
    total_employees: totalEmployees,
    active_employees: activeEmployees,
    tasks_in_progress: tasksInProgress,
    pending_tasks: pendingTasks,
    // Debug aid: how many open attendance docs matched (not distinct people)
    _debug_open_attendance_docs: await attendance.countDocuments(activeAttendanceQuery),
    _debug_work_date: today,
  };
}

app.use('/api/dashboard/summary', eventHandler(async (event) => {
  if (event.method !== 'GET') {
    event.node.res.statusCode = 405;
    return { success: false, error: 'Method not allowed' };
  }
  try {
    await requireDesktopSession(event);
    return await dashboardSummary();
  } catch (error: any) {
    event.node.res.statusCode = error?.statusCode || 500;
    console.error('Desktop dashboard summary error:', error?.message || error);
    return { success: false, error: error?.message || 'Unable to load dashboard.' };
  }
}));


app.use('/api/attendance/history', eventHandler(async (event) => {
  if (event.method !== 'GET') {
    event.node.res.statusCode = 405;
    return { success: false, error: 'Method not allowed' };
  }
  try {
    const { db, employee } = await requireDesktopSession(event);
    const url = new URL(event.node.req.url || '', `http://${event.node.req.headers.host}`);
    const daysParam = parseInt(url.searchParams.get('days') || '30', 10);
    const days = Number.isFinite(daysParam) ? Math.min(Math.max(daysParam, 1), 90) : 30;

    const today = todaySouthAfrica();
    // Inclusive window: today minus (days-1)
    const start = new Date(`${today}T12:00:00.000Z`);
    start.setUTCDate(start.getUTCDate() - (days - 1));
    const startDate = start.toISOString().slice(0, 10);

    const values = employeeReferenceValues(employee._id);
    const records = await db.collection('attendance')
      .find({
        employee_id: { $in: values },
        work_date: { $gte: startDate, $lte: today },
      })
      .sort({ work_date: -1, clock_in_at: -1 })
      .limit(90)
      .toArray();

    return {
      success: true,
      work_date_from: startDate,
      work_date_to: today,
      count: records.length,
      records: records.map((r: any) => serialiseAttendance(r)),
    };
  } catch (error: any) {
    event.node.res.statusCode = error?.statusCode || 500;
    return { success: false, error: error?.message || 'Unable to load attendance history.' };
  }
}));

app.use('/api/attendance/working-now', eventHandler(async (event) => {
  if (event.method !== 'GET') {
    event.node.res.statusCode = 405;
    return { success: false, error: 'Method not allowed' };
  }
  try {
    await requireDesktopSession(event);
    const db = mongoRequired();
    const today = todaySouthAfrica();
    const query: any = {
      work_date: today,
      employee_id: { $exists: true, $nin: [null, ''] },
      clock_in_at: { $exists: true, $nin: [null, ''] },
      $or: [
        { clock_out_at: { $exists: false } },
        { clock_out_at: null },
        { clock_out_at: '' },
      ],
    };
    const rows = await db.collection('attendance').find(query).limit(200).toArray();
    return {
      success: true,
      work_date: today,
      count: rows.length,
      records: rows.map((r: any) => ({
        employee_id: r.employee_id?.toString?.() ?? r.employee_id,
        employee_name: r.employee_name || null,
        status: r.status || null,
        clock_in_at: r.clock_in_at || null,
        clock_out_at: r.clock_out_at ?? null,
        work_date: r.work_date,
      })),
    };
  } catch (error: any) {
    event.node.res.statusCode = error?.statusCode || 500;
    return { success: false, error: error?.message || 'Unable to list working attendance.' };
  }
}));

// ============================================
// START SERVER
// ============================================

async function startServer() {
  await connectDB();
  
  const server = createServer(toNodeListener(app));

// ============================================================
// ORDER ASSIGNMENT (same pattern as quotes; h3 strips mount prefix)
// ============================================================
app.use('/api/admin/orders', eventHandler(async (event) => {
  const method = String(event.method || '').toUpperCase();
  const rawUrl = String(event.node.req.url || '');
  const pathname = rawUrl.split('?')[0];

  const match =
    pathname.match(
      /^\/api\/admin\/orders\/([^/]+)\/(assignment|assign|assign-employee|assign_employee)\/?$/
    ) ||
    pathname.match(
      /^\/([^/]+)\/(assignment|assign|assign-employee|assign_employee)\/?$/
    );

  if (!match) return;

  console.log(`🚨 ORDER ASSIGNMENT HIT: ${method} ${rawUrl}`);

  if (!['PUT', 'POST', 'PATCH'].includes(method)) {
    event.node.res.statusCode = 405;
    return { success: false, error: 'Method not allowed for order assignment' };
  }

  try {
    const reference = decodeURIComponent(match[1]).trim().toUpperCase();
    const body = await readBody(event);
    const { db, user } = await requireManagementSession(event);

    const requested =
      body?.employee_id ??
      body?.employeeId ??
      body?.assigned_to ??
      body?.assignedTo ??
      body?.employee ??
      body?.employeeID ??
      null;

    console.log(
      `👤 ORDER ASSIGNMENT REQUEST: order=${reference} employee=${requested ?? 'UNASSIGN'} method=${method}`
    );

    let assignedTo: any = null;

    if (requested !== null && requested !== undefined && String(requested).trim() !== '') {
      // Same robust lookup as quote assignment (ObjectId, numeric id, email, etc.)
      const employee = await findEmployeeByReference(db, requested);

      if (!employee) {
        console.error(`❌ ORDER ASSIGNMENT EMPLOYEE NOT FOUND: ${String(requested)}`);
        return {
          success: false,
          error: `Employee not found: ${String(requested)}`,
          code: 'EMPLOYEE_NOT_FOUND',
        };
      }

      if (!isActive(employee.status, true)) {
        return {
          success: false,
          error: `Employee is inactive: ${employeeDisplayName(employee)}`,
          code: 'EMPLOYEE_INACTIVE',
        };
      }

      const linkedUser = await db.collection('users').findOne({
        $or: [
          { employee_id: employee.employee_id },
          { employee_id: employee._id },
          ...(employee.email ? [{ email: employee.email }] : []),
        ],
      });

      assignedTo = safeEmployeePayload(employee, linkedUser);
      console.log(
        `👤 ORDER ASSIGNMENT EMPLOYEE FOUND: employee_id=${assignedTo.employee_id} name=${assignedTo.full_name}`
      );
    }

    let order: any = null;
    if (isMongoConnected) {
      const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&');
      order = await Order.findOne({
        $or: [
          { reference },
          { reference: { $regex: `^${escaped}$`, $options: 'i' } },
        ],
      });
      if (!order) {
        const raw = await db.collection('orders').findOne({
          reference: { $regex: `^${escaped}$`, $options: 'i' },
        });
        if (raw) order = await Order.findById(raw._id);
      }
    } else {
      order = inMemoryOrders.find(
        (o: any) => String(o?.reference || '').trim().toUpperCase() === reference
      );
    }

    if (!order) {
      return {
        success: false,
        error: `Order not found: ${reference}`,
        code: 'ORDER_NOT_FOUND',
      };
    }

    const actor = {
      id: user?._id?.toString?.() ?? user?._id ?? null,
      username: user?.username || user?.email || '',
      full_name: user?.full_name || user?.username || user?.email || '',
    };

    order.assigned_to = assignedTo;
    order.assigned_by = assignedTo ? actor : null;
    if (assignedTo && String(order.status || '').toLowerCase() === 'pending') {
      order.status = 'assigned';
    }

    if (isMongoConnected) {
      order.updatedAt = new Date();
      await order.save();
    }

    console.log(
      `✅ ORDER ASSIGNMENT SUCCESS: order=${reference} employee=${assignedTo?.employee_id || 'UNASSIGNED'}`
    );

    return {
      success: true,
      message: assignedTo ? 'Order assigned successfully.' : 'Order unassigned successfully.',
      order: {
        reference: order.reference,
        status: order.status,
        assigned_to: order.assigned_to,
        assigned_by: order.assigned_by,
      },
    };
  } catch (error: any) {
    console.error('❌ Order assignment error:', error);
    const status = error?.statusCode || error?.status || 500;
    event.node.res.statusCode = status;
    return {
      success: false,
      error: error?.message || 'Order assignment failed',
      code: error?.code || 'ORDER_ASSIGNMENT_FAILED',
    };
  }
}));


// ============================================
// TASKS / WORK ASSIGNMENTS (desktop Tasks UI)
// Collection: work_assignments
// ============================================

function serialiseTask(doc: any) {
  if (!doc) return null;
  const assignee =
    doc.assigned_employee ||
    doc.assignee ||
    (typeof doc.assigned_to === 'string' ? doc.assigned_to : doc.assigned_to?.full_name || doc.assigned_to?.name) ||
    '';
  return {
    id: doc._id?.toString?.() ?? doc.id,
    _id: doc._id?.toString?.() ?? doc._id,
    title: doc.title || doc.name || 'Untitled',
    description: doc.description || '',
    assigned_employee: assignee,
    assignee,
    assigned_to: doc.assigned_to || assignee,
    assigned_by: doc.assigned_by || '',
    priority: doc.priority || 'Normal',
    status: doc.status || 'Pending',
    department: doc.department || '',
    created_date: doc.created_at || doc.created_date || null,
    created_at: doc.created_at || null,
    start_date: doc.start_date || null,
    due_date: doc.due_date || null,
    estimated_hours: Number(doc.estimated_hours) || 0,
    actual_hours: Number(doc.actual_hours) || 0,
    category: doc.category || 'Administration',
    comments: doc.comments || '',
    checklist: doc.checklist || '[]',
    attachments: doc.attachments || '[]',
    active_timer_started_at: doc.active_timer_started_at || null,
    director_approval_status: doc.director_approval_status || null,
    returned_reason: doc.returned_reason || null,
  };
}

function taskScopeFilter(scope: string, sessionCtx: any) {
  const s = String(scope || 'all').toLowerCase();
  const done = { $nin: ['Completed', 'Cancelled', 'Canceled', 'Closed', 'closed', 'Done', 'done'] };
  const name =
    sessionCtx?.employee?.full_name ||
    [sessionCtx?.employee?.first_name, sessionCtx?.employee?.surname].filter(Boolean).join(' ') ||
    sessionCtx?.user?.full_name ||
    sessionCtx?.user?.username ||
    '';
  if (s === 'inbox' || s === 'personal') {
    return {
      status: done,
      $or: [
        { assigned_employee: name },
        { assignee: name },
        { 'assigned_to.full_name': name },
        { 'assigned_to.name': name },
        { assigned_to: name },
      ],
    };
  }
  if (s === 'reviews') {
    return { status: { $in: ['Waiting Review', 'waiting review', 'Waiting for Review', 'waiting_for_review'] } };
  }
  if (s === 'overdue') {
    return { due_date: { $lt: new Date() }, status: done };
  }
  if (s === 'department') {
    const dept = sessionCtx?.employee?.department || sessionCtx?.user?.department;
    return dept ? { department: dept, status: done } : { status: done };
  }
  return {};
}

app.use('/api/tasks', eventHandler(async (event) => {
  try {
    const ctx = await requireDesktopSession(event);
    const db = ctx.db;
    const col = db.collection('work_assignments');

    if (event.method === 'GET') {
      const q = getQuery(event) || {};
      const scope = String(q.scope || 'all');
      const filter = taskScopeFilter(scope, ctx);
      const items = await col.find(filter).sort({ created_at: -1, due_date: 1 }).limit(500).toArray();
      const tasks = items.map(serialiseTask);
      return { success: true, count: tasks.length, tasks, items: tasks };
    }

    if (event.method === 'POST') {
      const body = (await readBody(event)) || {};
      const title = String(body.title || '').trim();
      if (!title) {
        event.node.res.statusCode = 400;
        return { success: false, error: 'Title is required.' };
      }
      const assignee = String(
        body.assigned_employee || body.assignee || body.assigned_to || ''
      ).trim();
      const status = String(body.status || (assignee ? 'Assigned' : 'Pending'));
      const now = new Date();
      let due: Date | null = null;
      if (body.due_date) {
        const d = new Date(body.due_date);
        if (!Number.isNaN(d.getTime())) due = d;
      }
      const creator =
        ctx.employee?.full_name ||
        ctx.user?.full_name ||
        ctx.user?.username ||
        'System';
      // Persist attachments (array or JSON string) so employees can open files
      let attachmentsValue: any = '[]';
      try {
        const rawAtt = body.attachments ?? body.attachments_json;
        if (Array.isArray(rawAtt)) {
          // Cap each base64 payload to ~3.5MB to stay under MongoDB doc limits
          const safe = rawAtt.slice(0, 10).map((a: any) => {
            if (!a || typeof a !== 'object') return a;
            const copy = { ...a };
            if (typeof copy.content_base64 === 'string' && copy.content_base64.length > 5_000_000) {
              copy.content_base64 = '';
              copy.too_large = true;
            }
            return copy;
          });
          attachmentsValue = JSON.stringify(safe);
        } else if (typeof rawAtt === 'string' && rawAtt.trim()) {
          attachmentsValue = rawAtt;
        }
      } catch {
        attachmentsValue = '[]';
      }
      const doc: any = {
        title,
        description: String(body.description || ''),
        assigned_employee: assignee,
        assignee,
        assigned_to: assignee,
        assigned_by: creator,
        priority: String(body.priority || 'Normal'),
        status,
        department: String(body.department || ctx.employee?.department || ''),
        due_date: due,
        estimated_hours: Number(body.estimated_hours) || 0,
        actual_hours: 0,
        category: String(body.category || 'Administration'),
        comments: '',
        checklist: '[]',
        attachments: attachmentsValue,
        created_at: now,
        updated_at: now,
      };
      const result = await col.insertOne(doc);
      doc._id = result.insertedId;

      // Notify assignee (best-effort)
      if (assignee) {
        try {
          await db.collection('notifications').insertOne({
            recipient_name: assignee,
            recipient_role: 'All',
            title: 'New task assigned',
            message: `You were assigned "${title}"`,
            category: 'Task',
            reference_type: 'task',
            reference_id: result.insertedId.toString(),
            is_executive: false,
            is_read: false,
            created_at: now,
          });
        } catch (e) {
          console.warn('Task notification insert failed:', (e as any)?.message || e);
        }
      }

      const task = serialiseTask(doc);
      return { success: true, task, id: task.id };
    }

    event.node.res.statusCode = 405;
    return { success: false, error: 'Method not allowed' };
  } catch (error: any) {
    const status = error?.statusCode || 500;
    event.node.res.statusCode = status;
    return { success: false, error: error?.message || 'Tasks request failed' };
  }
}));

app.use('/api/tasks/workload', eventHandler(async (event) => {
  try {
    await requireDesktopSession(event);
    const db = mongoRequired();
    const items = await db.collection('work_assignments').aggregate([
      { $match: { status: { $nin: ['Completed', 'Cancelled', 'Canceled', 'Closed'] } } },
      {
        $group: {
          _id: { $ifNull: ['$assigned_employee', '$assignee'] },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 50 },
    ]).toArray();
    const workload = items.map((i: any) => ({ employee: i._id || 'Unassigned', count: i.count }));
    return { success: true, workload, items: workload };
  } catch (error: any) {
    event.node.res.statusCode = error?.statusCode || 500;
    return { success: false, error: error?.message || 'Workload failed' };
  }
}));

app.use('/api/tasks/decision-queue', eventHandler(async (event) => {
  try {
    await requireDesktopSession(event);
    const db = mongoRequired();
    const waiting = await db.collection('work_assignments')
      .find({ status: { $in: ['Waiting Review', 'waiting review', 'Waiting for Review'] } })
      .limit(100)
      .toArray();
    return {
      success: true,
      summary: { waiting_review: waiting.length },
      items: waiting.map(serialiseTask),
    };
  } catch (error: any) {
    event.node.res.statusCode = error?.statusCode || 500;
    return { success: false, error: error?.message || 'Decision queue failed' };
  }
}));

app.use('/api/tasks/:id/:action', eventHandler(async (event) => {
  try {
    const ctx = await requireDesktopSession(event);
    if (event.method !== 'POST') {
      event.node.res.statusCode = 405;
      return { success: false, error: 'Method not allowed' };
    }
    const db = ctx.db;
    const col = db.collection('work_assignments');
    const rawId = String(event.context.params?.id || '').trim();
    const action = String(event.context.params?.action || '').toLowerCase();
    const oid = safeObjectId(rawId);
    const filter = oid ? { _id: oid } : { _id: rawId as any };
    const existing = await col.findOne(filter);
    if (!existing) {
      event.node.res.statusCode = 404;
      return { success: false, error: 'Task not found' };
    }
    const body = (await readBody(event)) || {};
    const note = String(body.note || body.assignee || '');
    const $set: any = { updated_at: new Date() };
    const statusMap: Record<string, string> = {
      start: 'In Progress',
      pause: 'Assigned',
      'submit-review': 'Waiting Review',
      complete: 'Completed',
      'approve-review': 'Completed',
      return: 'Assigned',
      escalate: 'Escalated',
      cancel: 'Cancelled',
      assign: 'Assigned',
      'log-time': existing.status || 'In Progress',
    };
    if (action === 'assign' && note) {
      $set.assigned_employee = note;
      $set.assignee = note;
      $set.assigned_to = note;
    }
    if (action === 'log-time' && body.hours_logged != null) {
      $set.actual_hours = (Number(existing.actual_hours) || 0) + Number(body.hours_logged || 0);
    }
    if (statusMap[action]) $set.status = statusMap[action];
    if (note && action !== 'assign') $set.comments = note;
    await col.updateOne(filter, { $set });
    const updated = await col.findOne(filter);
    return { success: true, task: serialiseTask(updated) };
  } catch (error: any) {
    const status = error?.statusCode || 500;
    event.node.res.statusCode = status;
    return { success: false, error: error?.message || 'Task action failed' };
  }
}));

app.use('/api/tasks/:id', eventHandler(async (event) => {
  try {
    const ctx = await requireDesktopSession(event);
    const db = ctx.db;
    const col = db.collection('work_assignments');
    const rawId = String(event.context.params?.id || '').trim();
    const oid = safeObjectId(rawId);
    const filter = oid ? { _id: oid } : { _id: rawId as any };
    const existing = await col.findOne(filter);
    if (!existing) {
      event.node.res.statusCode = 404;
      return { success: false, error: 'Task not found' };
    }

    if (event.method === 'GET') {
      return { success: true, task: serialiseTask(existing) };
    }

    if (event.method === 'PATCH' || event.method === 'PUT') {
      const body = (await readBody(event)) || {};
      const $set: any = { updated_at: new Date() };
      const map: Record<string, string> = {
        title: 'title',
        description: 'description',
        priority: 'priority',
        status: 'status',
        department: 'department',
        category: 'category',
        comments: 'comments',
        estimated_hours: 'estimated_hours',
        actual_hours: 'actual_hours',
        hours_logged: 'actual_hours',
        note: 'comments',
      };
      for (const [k, field] of Object.entries(map)) {
        if (body[k] !== undefined) $set[field] = body[k];
      }
      // Attachments: accept array or JSON string
      if (body.attachments !== undefined || body.attachments_json !== undefined) {
        const rawAtt = body.attachments ?? body.attachments_json;
        if (Array.isArray(rawAtt)) {
          $set.attachments = JSON.stringify(rawAtt);
        } else if (typeof rawAtt === 'string') {
          $set.attachments = rawAtt || '[]';
        }
      }
      if (body.due_date !== undefined) {
        const d = body.due_date ? new Date(body.due_date) : null;
        $set.due_date = d && !Number.isNaN(d.getTime()) ? d : null;
      }
      const assignee = body.assigned_employee ?? body.assignee ?? body.assigned_to;
      if (assignee !== undefined) {
        const a = String(assignee || '').trim();
        $set.assigned_employee = a;
        $set.assignee = a;
        $set.assigned_to = a;
        if (a && !$set.status) $set.status = 'Assigned';
      }
      await col.updateOne(filter, { $set });
      const updated = await col.findOne(filter);

      // Notify on assignment change
      if (assignee !== undefined) {
        const a = String(assignee || '').trim();
        if (a) {
          try {
            await db.collection('notifications').insertOne({
              recipient_name: a,
              recipient_role: 'All',
              title: 'Task assigned to you',
              message: `You were assigned "${updated?.title || existing.title}"`,
              category: 'Task',
              reference_type: 'task',
              reference_id: String(existing._id),
              is_executive: false,
              is_read: false,
              created_at: new Date(),
            });
          } catch {}
        }
      }

      return { success: true, task: serialiseTask(updated) };
    }

    event.node.res.statusCode = 405;
    return { success: false, error: 'Method not allowed' };
  } catch (error: any) {
    const status = error?.statusCode || 500;
    event.node.res.statusCode = status;
    return { success: false, error: error?.message || 'Task request failed' };
  }
}));

// ============================================
// NOTIFICATIONS (desktop badge + list)
// ============================================

function serialiseNotification(doc: any) {
  if (!doc) return null;
  return {
    id: doc._id?.toString?.() ?? doc.id,
    _id: doc._id?.toString?.() ?? doc._id,
    recipient_role: doc.recipient_role || 'All',
    recipient_name: doc.recipient_name || '',
    title: doc.title || '',
    message: doc.message || doc.body || '',
    category: doc.category || 'General',
    reference_type: doc.reference_type || '',
    reference_id: doc.reference_id || null,
    is_executive: !!doc.is_executive,
    is_read: !!(doc.is_read || doc.read),
    created_at: doc.created_at || null,
  };
}

app.use('/api/notifications/unread-count', eventHandler(async (event) => {
  try {
    const ctx = await requireDesktopSession(event);
    const db = ctx.db;
    const name =
      ctx.employee?.full_name ||
      ctx.user?.full_name ||
      ctx.user?.username ||
      '';
    const role = ctx.user?.role || ctx.employee?.role || '';
    const count = await db.collection('notifications').countDocuments({
      is_read: { $ne: true },
      $or: [
        { recipient_name: name },
        { recipient_role: role },
        { recipient_role: 'All' },
        { recipient_role: { $exists: false } },
      ],
    });
    return { success: true, count, unread: count };
  } catch (error: any) {
    event.node.res.statusCode = error?.statusCode || 500;
    return { success: false, error: error?.message || 'Unread count failed', count: 0 };
  }
}));

app.use('/api/notifications/read-all', eventHandler(async (event) => {
  try {
    const ctx = await requireDesktopSession(event);
    if (event.method !== 'POST') {
      event.node.res.statusCode = 405;
      return { success: false, error: 'Method not allowed' };
    }
    const db = ctx.db;
    const body = (await readBody(event)) || {};
    const name =
      ctx.employee?.full_name ||
      ctx.user?.full_name ||
      ctx.user?.username ||
      '';
    const role = body.role && body.role !== 'All' ? body.role : (ctx.user?.role || ctx.employee?.role || '');
    const filter: any = {
      is_read: { $ne: true },
      $or: [
        { recipient_name: name },
        { recipient_role: role },
        { recipient_role: 'All' },
      ],
    };
    const result = await db.collection('notifications').updateMany(filter, {
      $set: { is_read: true, read_at: new Date() },
    });
    return { success: true, count: result.modifiedCount, updated: result.modifiedCount };
  } catch (error: any) {
    event.node.res.statusCode = error?.statusCode || 500;
    return { success: false, error: error?.message || 'Mark all read failed' };
  }
}));

app.use('/api/notifications/:id/read', eventHandler(async (event) => {
  try {
    await requireDesktopSession(event);
    if (event.method !== 'POST' && event.method !== 'PATCH') {
      event.node.res.statusCode = 405;
      return { success: false, error: 'Method not allowed' };
    }
    const db = mongoRequired();
    const rawId = String(event.context.params?.id || '').trim();
    const oid = safeObjectId(rawId);
    const filter = oid ? { _id: oid } : { _id: rawId as any };
    await db.collection('notifications').updateOne(filter, {
      $set: { is_read: true, read_at: new Date() },
    });
    return { success: true };
  } catch (error: any) {
    event.node.res.statusCode = error?.statusCode || 500;
    return { success: false, error: error?.message || 'Mark read failed' };
  }
}));

app.use('/api/notifications', eventHandler(async (event) => {
  try {
    const ctx = await requireDesktopSession(event);
    const db = ctx.db;
    const col = db.collection('notifications');

    if (event.method === 'GET') {
      const q = getQuery(event) || {};
      const role = String(q.role || 'All');
      const unreadOnly = String(q.unread || '') === '1';
      const name =
        ctx.employee?.full_name ||
        ctx.user?.full_name ||
        ctx.user?.username ||
        '';
      const filter: any = {
        $or: [
          { recipient_name: name },
          { recipient_role: 'All' },
          { recipient_role: { $exists: false } },
        ],
      };
      if (role && role !== 'All') {
        filter.$or.push({ recipient_role: role });
      } else if (ctx.user?.role || ctx.employee?.role) {
        filter.$or.push({ recipient_role: ctx.user?.role || ctx.employee?.role });
      }
      if (unreadOnly) filter.is_read = { $ne: true };
      const items = await col.find(filter).sort({ created_at: -1 }).limit(200).toArray();
      const notifications = items.map(serialiseNotification);
      return { success: true, count: notifications.length, notifications, items: notifications };
    }

    if (event.method === 'POST') {
      const body = (await readBody(event)) || {};
      const now = new Date();
      const doc = {
        recipient_name: String(body.user_name || body.recipient_name || ''),
        recipient_role: String(body.recipient_role || 'All'),
        title: String(body.title || body.category || 'Notification'),
        message: String(body.message || ''),
        category: String(body.category || 'General'),
        reference_type: String(body.reference_type || ''),
        reference_id: body.reference_id || null,
        is_executive: !!body.is_executive,
        is_read: false,
        created_at: now,
      };
      const result = await col.insertOne(doc);
      return { success: true, id: result.insertedId.toString(), notification: serialiseNotification({ ...doc, _id: result.insertedId }) };
    }

    event.node.res.statusCode = 405;
    return { success: false, error: 'Method not allowed' };
  } catch (error: any) {
    event.node.res.statusCode = error?.statusCode || 500;
    return { success: false, error: error?.message || 'Notifications failed' };
  }
}));


server.listen(config.port, '0.0.0.0', () => {
    console.log(`\n🚀 Server running on http://localhost:${config.port}`);
    console.log(`🛠️ Assignment API: PUT/POST/PATCH /api/admin/quotes/:reference/assignment`);
    console.log(`🛠️ Assignment aliases: /assign, /assign-employee, /assignment/employee`);
    console.log(`🧩 Assignment dispatcher: UNIVERSAL-FIXED-v2`);
    console.log(`📡 API available at http://localhost:${config.port}/api`);
    console.log(`🏥 Health check: http://localhost:${config.port}/api/health`);
    console.log(`🔍 Track Quote API: http://localhost:${config.port}/api/quotes/track?ref=UQ-XXXXXX&email=you@email.com`);
    console.log(`📋 Quotes API: http://localhost:${config.port}/api/quotes`);
    console.log(`💬 Feedback API: http://localhost:${config.port}/api/quotes/feedback`);
    console.log(`💳 Payment API: http://localhost:${config.port}/api/quotes/payment`);
    console.log(`🔍 Track Order API: http://localhost:${config.port}/api/orders/track?ref=ORD-XXXXXX&email=you@email.com`);
    console.log(`📋 Orders API: http://localhost:${config.port}/api/orders`);
    console.log(`🔧 Admin API: http://localhost:${config.port}/api/admin/quotes/:reference`);
    console.log(`💳 Set Payment: http://localhost:${config.port}/api/admin/quotes/:reference/payment`);
    console.log(`💰 Extract Payment: http://localhost:${config.port}/api/admin/quotes/:reference/extract-payment`);
    console.log(`🔄 Set Status: http://localhost:${config.port}/api/admin/quotes/:reference/status`);
    console.log(`🔄 Simulate Payment: http://localhost:${config.port}/api/payment/simulate/:reference`);
    console.log(`💾 Storage mode: ${isMongoConnected ? 'MongoDB ✅' : 'In-Memory ⚠️'}`);
    console.log(`✅ Tasks API: http://localhost:${config.port}/api/tasks`);
    console.log(`🔔 Notifications API: http://localhost:${config.port}/api/notifications`);
    console.log(`\n✅ Server is ready!\n`);
  });
}

startServer();
