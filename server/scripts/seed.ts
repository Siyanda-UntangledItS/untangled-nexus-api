import mongoose from 'mongoose';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { Product, Service, CatalogItem } from '../db/index.js';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/untangled-it';

async function seedDatabase() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    // Import data from the sibling Frontend project without making TypeScript
    // type-check this optional cross-project dependency. The backend ZIP can
    // run independently; seeding requires the full project layout.
    const frontendRoot = resolve(process.cwd(), '../Frontend/src/lib');
    const storeDataUrl = pathToFileURL(resolve(frontendRoot, 'store-data.ts')).href;
    const catalogUrl = pathToFileURL(resolve(frontendRoot, 'catalog.ts')).href;

    const { products, services } = await import(storeDataUrl);
    const { CATALOG } = await import(catalogUrl);

    // Clear existing data
    await Product.deleteMany({});
    await Service.deleteMany({});
    await CatalogItem.deleteMany({});
    console.log('Cleared existing data');

    // Insert data
    await Product.insertMany(products);
    console.log(`✅ Inserted ${products.length} products`);

    await Service.insertMany(services);
    console.log(`✅ Inserted ${services.length} services`);

    await CatalogItem.insertMany(CATALOG);
    console.log(`✅ Inserted ${CATALOG.length} catalog items`);

    console.log('✨ Seeding completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('❌ Seeding failed:', error);
    process.exit(1);
  }
}

seedDatabase();
