import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/krishi_mama");
  const hash = await bcrypt.hash("admin123", 12);
  const result = await mongoose.connection.db.collection("users").updateOne(
    { email: "admin@demo.com" },
    {
      $set: {
        name: "Demo Admin",
        email: "admin@demo.com",
        passwordHash: hash,
        role: "admin",
        preferredDistrict: "chattogram",
        authProvider: "local",
        updatedAt: new Date(),
      },
      $setOnInsert: {
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );
  console.log("admin@demo.com seeded successfully:", result);
  await mongoose.disconnect();
}

seed().catch(console.error);
