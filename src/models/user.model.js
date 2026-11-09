import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const DISTRICT_VALUES = ["chattogram", "cumilla"];
const ROLE_VALUES = ["farmer", "extension_officer", "admin"];

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      minlength: [2, "Name must be at least 2 characters"],
      maxlength: [80, "Name cannot exceed 80 characters"],
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        "Please provide a valid email address",
      ],
      index: true,
    },
    passwordHash: {
      type: String,
      required: function () {
        return this.authProvider === "local" && !this.googleId;
      },
      select: false,
    },
    googleId: {
      type: String,
      sparse: true,
      index: true,
      default: null,
    },
    authProvider: {
      type: String,
      enum: ["local", "google"],
      default: "local",
    },
    avatarUrl: {
      type: String,
      default: null,
    },
    preferredDistrict: {
      type: String,
      enum: {
        values: DISTRICT_VALUES,
        message: "District must be either 'chattogram' or 'cumilla'",
      },
      default: "chattogram",
    },
    role: {
      type: String,
      enum: {
        values: ROLE_VALUES,
        message: "Role must be 'farmer', 'extension_officer', or 'admin'",
      },
      default: "farmer",
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        delete ret.passwordHash;
        delete ret.__v;
        return ret;
      },
    },
    toObject: {
      transform: (_doc, ret) => {
        delete ret.passwordHash;
        delete ret.__v;
        return ret;
      },
    },
  }
);

/**
 * Hash a plaintext password using bcrypt with 12 salt rounds.
 */
userSchema.statics.hashPassword = async function (plaintextPassword) {
  if (!plaintextPassword || typeof plaintextPassword !== "string") {
    throw new Error("Password must be a non-empty string");
  }
  return bcrypt.hash(plaintextPassword, 12);
};

/**
 * Compare candidate password with the stored password hash.
 */
userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!candidatePassword || !this.passwordHash) {
    return false;
  }
  return bcrypt.compare(candidatePassword, this.passwordHash);
};

export const User = mongoose.model("User", userSchema);
