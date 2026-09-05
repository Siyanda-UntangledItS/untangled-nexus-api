import mongoose, { Schema, Document } from 'mongoose';

export interface IProduct extends Document {
  id: string;
  name: string;
  brand: string;
  category: string;
  segment: 'products' | 'business' | 'refurbished';
  shortDescription: string;
  specs: string[];
  price: number | null;
  availability: 'in-stock' | 'low-stock' | 'on-order';
  quoteOnly?: boolean;
  condition?: string;
  grade?: string;
  warranty?: string;
  keywords?: string[];
  createdAt: Date;
  updatedAt: Date;
}

const ProductSchema = new Schema<IProduct>(
  {
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    brand: { type: String, required: true },
    category: { type: String, required: true },
    segment: { 
      type: String, 
      enum: ['products', 'business', 'refurbished'], 
      required: true 
    },
    shortDescription: { type: String, required: true },
    specs: [{ type: String }],
    price: { type: Number, default: null },
    availability: { 
      type: String, 
      enum: ['in-stock', 'low-stock', 'on-order'], 
      default: 'in-stock' 
    },
    quoteOnly: { type: Boolean, default: false },
    condition: { type: String },
    grade: { type: String },
    warranty: { type: String },
    keywords: [{ type: String }],
  },
  {
    timestamps: true,
  }
);

ProductSchema.index({ name: 'text', brand: 'text', shortDescription: 'text', keywords: 'text' });
ProductSchema.index({ category: 1, segment: 1 }, { name: 'product_category_segment' });
ProductSchema.index({ segment: 1, createdAt: -1 }, { name: 'product_segment_created' });

const Product = mongoose.model<IProduct>('Product', ProductSchema);
export default Product;