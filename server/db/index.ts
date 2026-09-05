// Central MongoDB connection and model exports.
import mongoose from 'mongoose';
import Product from '../models/Product.js';
import Service from '../models/Service.js';
import CatalogItem from '../models/CatalogItem.js';
import Order from '../models/Order.js';
import Quote from '../models/Quote.js';
import { config } from '../config/index.js';

let connectPromise: Promise<typeof mongoose.connection> | null = null;
let indexesPromise: Promise<void> | null = null;

const connectionOptions: mongoose.ConnectOptions = {
  maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 20),
  minPoolSize: Number(process.env.MONGODB_MIN_POOL_SIZE || 5),
  maxIdleTimeMS: Number(process.env.MONGODB_MAX_IDLE_TIME_MS || 30000),
  serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000),
  socketTimeoutMS: Number(process.env.MONGODB_SOCKET_TIMEOUT_MS || 10000),
  connectTimeoutMS: Number(process.env.MONGODB_CONNECT_TIMEOUT_MS || 5000),
  family: 4,
};

async function ensureIndexes(): Promise<void> {
  if (indexesPromise) return indexesPromise;

  indexesPromise = (async () => {
    // Mongoose models used by the public website/API.
    await Promise.all([
      Product.createIndexes(),
      Service.createIndexes(),
      CatalogItem.createIndexes(),
      Order.createIndexes(),
      Quote.createIndexes(),
    ]);

    // Collections used by the desktop/admin API are native Mongo collections.
    // These indexes match the high-frequency lookup/count paths in index-desktop.ts.
    const db = mongoose.connection.db;
    if (!db) return;

    await Promise.all([
      db.collection('users').createIndex({ username: 1 }, { name: 'users_username_1' }),
      db.collection('users').createIndex({ email: 1 }, { name: 'users_email_1' }),
      db.collection('users').createIndex({ employee_id: 1 }, { name: 'users_employee_id_1' }),
      db.collection('api_sessions').createIndex({ token: 1 }, { name: 'api_sessions_token_1' }),
      db.collection('api_sessions').createIndex({ user_id: 1, status: 1 }, { name: 'api_sessions_user_status' }),
      db.collection('employees').createIndex({ employee_id: 1 }, { name: 'employees_employee_id_1' }),
      db.collection('employees').createIndex({ email: 1 }, { name: 'employees_email_1' }),
      db.collection('employees').createIndex({ status: 1 }, { name: 'employees_status_1' }),
      db.collection('attendance').createIndex({ employee_id: 1, work_date: 1 }, { name: 'attendance_employee_date' }),
      db.collection('attendance').createIndex({ work_date: 1, clock_out_at: 1, status: 1 }, { name: 'attendance_open_today' }),
      db.collection('work_assignments').createIndex({ due_date: 1, status: 1 }, { name: 'work_due_status' }),
      db.collection('approvals').createIndex({ status: 1 }, { name: 'approvals_status_1' }),
      db.collection('quotes').createIndex({ assigned_to: 1, status: 1, createdAt: -1 }, { name: 'quotes_assignment_status_date' }),
      db.collection('orders').createIndex({ assigned_to: 1, status: 1, createdAt: -1 }, { name: 'orders_assignment_status_date' }),
    ]);
  })().catch((error) => {
    indexesPromise = null;
    throw error;
  });

  return indexesPromise;
}

export async function connectDB(): Promise<typeof mongoose.connection> {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (connectPromise) return connectPromise;

  if (!config.mongoUri) {
    throw new Error('MONGODB_URI environment variable is required');
  }
  if (config.mongoUri.startsWith('MONGODB_URI=')) {
    throw new Error('Invalid MONGODB_URI format');
  }

  connectPromise = mongoose.connect(config.mongoUri, connectionOptions)
    .then(async () => {
      await ensureIndexes();
      return mongoose.connection;
    })
    .catch((error) => {
      connectPromise = null;
      throw error;
    });

  return connectPromise;
}

export async function closeDB(): Promise<void> {
  connectPromise = null;
  indexesPromise = null;
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
  }
}

export function isDBConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

export { Product, Service, CatalogItem, Order, Quote };
export default mongoose;
