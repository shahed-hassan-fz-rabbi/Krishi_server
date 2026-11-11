import "../config/env.config.js";
import { connectDatabase, disconnectDatabase } from "../config/database.js";
import { User } from "../models/user.model.js";

// Build replacement uniqueness protections before retiring the legacy index.
// No user documents are modified or removed.
try {
  await connectDatabase({ required: true });
  await User.collection.createIndex({ email: 1 }, { name: "uniq_email_present", unique: true, partialFilterExpression: { email: { $type: "string" } } });
  await User.collection.createIndex({ phone: 1 }, { name: "uniq_phone_present", unique: true, partialFilterExpression: { phone: { $type: "string" } } });
  const indexes = await User.collection.indexes();
  for (const index of indexes) {
    if (index.name !== "uniq_email_present" && index.unique && Object.keys(index.key).length === 1 && index.key.email === 1 && !index.partialFilterExpression && !index.sparse) {
      await User.collection.dropIndex(index.name);
    }
  }
  console.log("Contact indexes ready: unique email and phone; phone-only accounts supported.");
} catch (error) {
  console.error(`Contact index migration failed (${error.code || error.name}). No user documents were changed.`);
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
