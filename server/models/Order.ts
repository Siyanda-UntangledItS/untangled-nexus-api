// server/models/Order.ts
import mongoose, { Schema, Document } from 'mongoose';

export interface IOrder extends Document {
  reference: string; // Changed from orderId to reference for consistency
  customerName: string;
  company?: string;
  email: string;
  phone: string;
  address: string;
  notes?: string;
  items: Array<{
    id: string;
    name: string;
    qty: number;
    price: number;
  }>;
  total: number;
  status: 'pending' | 'confirmed' | 'processing' | 'shipped' | 'delivered' | 'cancelled';
  trackingNumber?: string;
  carrier?: string;
  estimatedDelivery?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const OrderSchema = new Schema<IOrder>(
  {
    reference: { type: String, required: true, unique: true, index: true },
    customerName: { type: String, required: true },
    company: { type: String },
    email: { type: String, required: true, index: true },
    phone: { type: String, required: true },
    address: { type: String, required: true },
    notes: { type: String },
    items: [{
      id: { type: String, required: true },
      name: { type: String, required: true },
      qty: { type: Number, required: true, min: 1 },
      price: { type: Number, required: true, min: 0 },
    }],
    total: { type: Number, required: true, min: 0 },
    status: { 
      type: String, 
      enum: ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'],
      default: 'pending'
    },
    trackingNumber: { type: String },
    carrier: { type: String },
    estimatedDelivery: { type: Date },
  },
  {
    timestamps: true,
  }
);

OrderSchema.index({ reference: 1, email: 1 }, { name: 'order_tracking' });
OrderSchema.index({ createdAt: -1 }, { name: 'order_created_desc' });
OrderSchema.index({ status: 1, createdAt: -1 }, { name: 'order_status_created' });

// Generate reference before saving
OrderSchema.pre('save', function() {
  if (!this.reference) {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    this.reference = `ORD-${timestamp}-${random}`;
  }
});

const Order = mongoose.model<IOrder>('Order', OrderSchema);
export default Order;