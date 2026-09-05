import mongoose, { Schema, Document } from 'mongoose';

export interface ICatalogItem extends Document {
  id: string;
  name: string;
  category: 'refurbished' | 'accessories' | 'software' | 'services';
  blurb: string;
  from: number | null;
  unit?: string;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

const CatalogItemSchema = new Schema<ICatalogItem>(
  {
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    category: { 
      type: String, 
      enum: ['refurbished', 'accessories', 'software', 'services'], 
      required: true 
    },
    blurb: { type: String, required: true },
    from: { type: Number, default: null },
    unit: { type: String },
    tags: [{ type: String }],
  },
  {
    timestamps: true,
  }
);

CatalogItemSchema.index({ category: 1 });

const CatalogItem = mongoose.model<ICatalogItem>('CatalogItem', CatalogItemSchema);
export default CatalogItem;