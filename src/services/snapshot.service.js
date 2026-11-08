/**
 * Snapshot & Offline Resilience Service.
 * Provides fallback access to verified static reference datasets when MongoDB
 * is offline or disconnected, ensuring 100% demo continuity with full scientific honesty.
 *
 * Distinguishes:
 * - HISTORICAL_DATABASE: retrieved from local MongoDB records.
 * - SNAPSHOT: retrieved from verified static reference disk snapshot.
 * - UNAVAILABLE: neither database nor snapshot exists.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SNAPSHOTS_DIR = path.resolve(__dirname, "../../data/snapshots");

const memoryCache = new Map();

function loadJson(filePath) {
  if (memoryCache.has(filePath)) {
    return memoryCache.get(filePath);
  }
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    memoryCache.set(filePath, parsed);
    return parsed;
  } catch (err) {
    console.error(`[snapshot.service] Failed to parse snapshot file ${filePath}:`, err.message);
    return null;
  }
}

export const snapshotService = {
  /**
   * Check if MongoDB is connected and ready.
   */
  isDbConnected() {
    return mongoose.connection && mongoose.connection.readyState === 1;
  },

  /**
   * Clear in-memory snapshot cache.
   */
  clearCache() {
    memoryCache.clear();
  },

  /**
   * Retrieve climate analysis snapshot for a district.
   */
  getClimateSnapshot(districtCode) {
    if (!districtCode) return null;
    const norm = districtCode.toLowerCase().trim();
    const filePath = path.join(SNAPSHOTS_DIR, `${norm}_climate.json`);
    return loadJson(filePath);
  },

  /**
   * Retrieve handoff analysis snapshot for a district & transition.
   */
  getHandoffSnapshot(districtCode, transition) {
    if (!districtCode) return null;
    const normDist = districtCode.toLowerCase().trim();
    const normTrans = (transition || "aman-mustard").toLowerCase().trim();
    const filePath = path.join(SNAPSHOTS_DIR, `${normDist}_handoff.json`);
    const snapshot = loadJson(filePath);
    if (!snapshot || !snapshot.transitions) return null;

    const transitionData = snapshot.transitions[normTrans];
    if (!transitionData) return null;

    return {
      snapshotMetadata: snapshot.snapshotMetadata,
      data: transitionData,
    };
  },

  /**
   * Retrieve SMAP soil moisture snapshot observations for a district.
   */
  getSmapSnapshot(districtCode) {
    const filePath = path.join(SNAPSHOTS_DIR, "smap_observations.json");
    const snapshot = loadJson(filePath);
    if (!snapshot || !Array.isArray(snapshot.observations)) return null;

    const norm = (districtCode || "cumilla").toLowerCase().trim();
    const filtered = snapshot.observations.filter((obs) => obs.districtCode === norm);

    if (filtered.length === 0) return null;

    return {
      snapshotMetadata: snapshot.snapshotMetadata,
      observations: filtered,
      latest: filtered[0] || null,
    };
  },

  /**
   * Retrieve MODIS vegetation snapshot observations for a district.
   */
  getModisSnapshot(districtCode) {
    const filePath = path.join(SNAPSHOTS_DIR, "modis_observations.json");
    const snapshot = loadJson(filePath);
    if (!snapshot || !Array.isArray(snapshot.observations)) return null;

    const norm = (districtCode || "cumilla").toLowerCase().trim();
    const filtered = snapshot.observations.filter((obs) => obs.districtCode === norm);

    if (filtered.length === 0) return null;

    return {
      snapshotMetadata: snapshot.snapshotMetadata,
      observations: filtered,
      latest: filtered[0] || null,
    };
  },
};
