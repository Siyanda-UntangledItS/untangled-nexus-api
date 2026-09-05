// server/models/Quote.ts
import mongoose, { Schema, Document } from 'mongoose';
import type { QuoteStatus, PaymentStatus } from '../types/quote.types.js';
import { QUOTE_STATUSES, PAYMENT_STATUSES } from '../types/quote.types.js';

export interface IQuoteItem {
  id: string;
  name: string;
  kind: 'product' | 'service';
  qty: number;
  image?: string | null;
}

export interface IQuote extends Document {
  reference: string;
  customerName: string;
  company?: string;
  email: string;
  phone: string;
  notes?: string;
  items: IQuoteItem[];
  status: QuoteStatus;
  replyMessage?: string;
  repliedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  paymentRequired?: boolean;
  paymentAmount?: number;
  paymentStatus?: PaymentStatus;
  paymentReference?: string;
  feedback?: {
    rating?: number;
    comment?: string;
    submitted?: boolean;
    submittedAt?: Date;
  };
}

const QuoteSchema = new Schema<IQuote>(
  {
    reference: { type: String, required: true, unique: true, index: true },
    customerName: { type: String, required: true },
    company: { type: String },
    email: { type: String, required: true, index: true },
    phone: { type: String, required: true },
    notes: { type: String },
    items: [
      {
        id: { type: String, required: true },
        name: { type: String, required: true },
        kind: { type: String, enum: ['product', 'service'], required: true },
        qty: { type: Number, required: true, min: 1 },
        image: { type: String, default: null },
      },
    ],
    status: {
      type: String,
      enum: QUOTE_STATUSES,
      default: 'received',
      index: true,
    },
    replyMessage: { type: String },
    repliedAt: { type: Date },
    paymentRequired: { type: Boolean, default: false },
    paymentAmount: { type: Number },
    paymentStatus: {
      type: String,
      enum: PAYMENT_STATUSES,
      default: 'pending',
    },
    paymentReference: { type: String },
    feedback: {
      rating: { type: Number, min: 1, max: 5 },
      comment: { type: String },
      submitted: { type: Boolean, default: false },
      submittedAt: { type: Date },
    },
    // Desktop workflow extras (assignment / director review / audit trail)
    assignedTo: { type: Schema.Types.Mixed },
    assignedEmployeeId: { type: Schema.Types.Mixed },
    assignedAt: { type: Date },
    history: { type: [Schema.Types.Mixed], default: [] },
    directorReview: { type: Schema.Types.Mixed },
    progress: { type: Number },
    completed_at: { type: Date },
    completed_by: { type: String },
    accepted_at: { type: Date },
    accepted_by: { type: String },
  },
  { timestamps: true }
);

// Compound index for customer tracking lookups
QuoteSchema.index({ reference: 1, email: 1 }, { name: 'quote_tracking' });
QuoteSchema.index({ createdAt: -1 }, { name: 'quote_created_desc' });
QuoteSchema.index({ status: 1, createdAt: -1 }, { name: 'quote_status_created' });

const Quote =
  (mongoose.models.Quote as mongoose.Model<IQuote>) ||
  mongoose.model<IQuote>('Quote', QuoteSchema);

export default Quote;
