/**
 * Krishi Mama — Bangladesh Official Warning Service.
 * Manages verified official bulletins from Bangladesh Meteorological Department (BMD)
 * and Department of Disaster Management (DDM) / AWARE.
 * Ensures government bulletins are authenticated, dated, and strictly separated from
 * statistical forecast estimations.
 */

import mongoose from "mongoose";
import OfficialWarning from "../../models/officialwarning.model.js";

/**
 * Approved official government hostnames for Bangladesh weather bulletins and disaster alerts.
 * Strictly whitelists exact authorized government hosts, preventing arbitrary subdomain traversal.
 */
export const APPROVED_GOVERNMENT_HOSTS = new Set([
  "bmd.gov.bd",
  "www.bmd.gov.bd",
  "live3.bmd.gov.bd",
  "ddm.gov.bd",
  "www.ddm.gov.bd",
  "bamis.gov.bd",
  "www.bamis.gov.bd",
  "modmr.gov.bd",
  "www.modmr.gov.bd",
]);

export const TRUSTED_GOVERNMENT_DOMAINS = [
  "bmd.gov.bd",
  "ddm.gov.bd",
  "bamis.gov.bd",
  "modmr.gov.bd",
];

/**
 * Recognized issuing authorities for authentic government bulletins.
 * Exact match list to prevent suffix injection (e.g. "BMD forged authority").
 */
export const APPROVED_ISSUING_AUTHORITIES = [
  "Bangladesh Meteorological Department (BMD)",
  "Bangladesh Meteorological Department",
  "BMD",
  "Department of Disaster Management (DDM)",
  "Department of Disaster Management",
  "DDM",
  "Ministry of Disaster Management and Relief (MoDMR)",
  "Ministry of Disaster Management and Relief",
  "MoDMR",
  "Bangladesh Agro-Meteorological Information System (BAMIS)",
  "BAMIS",
  "BAMIS / Department of Agricultural Extension (DAE)",
  "Department of Agricultural Extension (DAE)",
  "DAE",
];

export const TRUSTED_ISSUING_AUTHORITIES = APPROVED_ISSUING_AUTHORITIES.map(
  (auth) => new RegExp(`^${auth.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i")
);

/**
 * Validates that a hostname strictly belongs to an approved government host.
 * Strictly defends against lookalike domains (e.g. bmd.gov.bd.attacker.com, fakebmd.gov.bd)
 * and unvetted arbitrary subdomains (e.g. not-approved-subdomain.bmd.gov.bd).
 */
export function isTrustedGovernmentHost(hostname) {
  if (!hostname || typeof hostname !== "string") return false;
  const cleanHost = hostname.trim().toLowerCase();
  return APPROVED_GOVERNMENT_HOSTS.has(cleanHost);
}

/**
 * Strict, auditable trust policy for official government bulletins.
 * Requires:
 * 1. Verified administrative status (verifiedByAdmin === true).
 * 2. Active status and non-synthetic/non-demo classification.
 * 3. Authentic bulletin identification format (rejects demo/test/synthetic placeholders).
 * 4. Recognized issuing authority (BMD, DDM, MoDMR, BAMIS) - exact match.
 * 5. Document provenance pointing to an approved government host with strict HTTPS,
 *    no URL userinfo, no open redirect paths or query parameters, and valid document path.
 * 6. Valid temporal horizon (validUntil in the future).
 * Fails closed if any condition is not met.
 */
export function isAuthenticGovernmentBulletin(w, referenceDate = new Date()) {
  if (!w || typeof w !== "object") return false;

  // 1. Explicit synthetic, demo, or inactive flags
  if (w.isSynthetic === true || w.isDemo === true || w.isActive === false) {
    return false;
  }

  // 2. Explicit administrative verification requirement
  if (w.verifiedByAdmin !== true) {
    return false;
  }

  // 3. Bulletin identification validation (rejects demo/test/placeholder formats)
  const bulletinNumber = (w.bulletinNumber || "").trim();
  if (!bulletinNumber || bulletinNumber.length < 5) {
    return false;
  }
  if (/(?:demo|test|sample|synthetic|placeholder|BMD-AGRI-ADV-2026)/i.test(bulletinNumber)) {
    return false;
  }

  // 4. Issuing authority validation (exact match against approved authorities)
  const authority = (w.issuingAuthority || "").trim();
  if (!authority) return false;
  const isApprovedAuthority = APPROVED_ISSUING_AUTHORITIES.some(
    app => app.toLowerCase() === authority.toLowerCase()
  );
  if (!isApprovedAuthority) {
    return false;
  }

  // 5. Source URL and hostname validation (Defends against external, lookalike, and forged hosts)
  const sourceUrl = (w.sourceUrl || "").trim();
  if (!sourceUrl) return false;

  let parsedUrl;
  try {
    parsedUrl = new URL(sourceUrl);
  } catch {
    return false;
  }

  // Enforce strict HTTPS only (reject insecure HTTP)
  if (parsedUrl.protocol !== "https:") {
    return false;
  }

  // Reject URL user-info (e.g. attacker@bmd.gov.bd)
  if (parsedUrl.username || parsedUrl.password) {
    return false;
  }

  // Strictly check against exact approved government hostnames
  if (!isTrustedGovernmentHost(parsedUrl.hostname)) {
    return false;
  }

  // Reject open redirect query parameters or path patterns
  const fullHref = parsedUrl.href.toLowerCase();
  if (/(?:\/redirect|\/goto|\/out|\?to=|\?url=|\?dest=|\?target=|\?redirect=)/i.test(fullHref)) {
    return false;
  }

  // Must point to a specific bulletin/document path, not a bare domain root
  const pathname = parsedUrl.pathname.replace(/\/+$/, "").toLowerCase();
  if (!pathname || pathname.length < 4 || pathname === "/") {
    return false;
  }

  // Document path structure verification
  const isDocPath =
    pathname.startsWith("/files/") ||
    pathname.startsWith("/bulletin/") ||
    pathname.startsWith("/advisory/") ||
    pathname.startsWith("/warning/") ||
    pathname.startsWith("/special_weather_bulletin") ||
    pathname.endsWith(".pdf") ||
    pathname.endsWith(".html");
  if (!isDocPath) {
    return false;
  }

  // 6. Temporal validity check
  if (w.validUntil) {
    const validUntilDate = new Date(w.validUntil);
    if (isNaN(validUntilDate.getTime()) || validUntilDate <= referenceDate) {
      return false;
    }
  }

  return true;
}

/**
 * Creates an unverified draft of an official government warning.
 * Drafts start as unverified (verifiedByAdmin: false, isActive: false).
 */
export async function createOfficialWarningDraft({ data, adminUserId }) {
  if (!adminUserId) {
    const err = new Error("Authenticated administrator required to create warning draft");
    err.statusCode = 401;
    throw err;
  }

  const warning = new OfficialWarning({
    ...data,
    isActive: false,
    verifiedByAdmin: false,
    verifiedByUserId: null,
    verifiedAt: null,
  });

  return await warning.save();
}

/**
 * Verified and activates an official government warning bulletin.
 * Performs full provenance and authority verification before activating.
 */
export async function verifyOfficialWarning({ warningId, adminUserId, notes = "" }) {
  if (!adminUserId) {
    const err = new Error("Authenticated administrator required to verify official warnings");
    err.statusCode = 401;
    throw err;
  }

  const warning = await OfficialWarning.findById(warningId);
  if (!warning) {
    const err = new Error("Official warning record not found");
    err.statusCode = 404;
    throw err;
  }

  // Validate the warning against the authenticity policy before publishing
  const testCandidate = {
    ...warning.toObject(),
    verifiedByAdmin: true,
    isActive: true,
  };

  if (!isAuthenticGovernmentBulletin(testCandidate)) {
    const err = new Error("Bulletin fails authenticity check: must have valid HTTPS sourceUrl from approved host, valid document path, recognized authority, and future validity.");
    err.statusCode = 422;
    throw err;
  }

  warning.verifiedByAdmin = true;
  warning.isActive = true;
  warning.verifiedByUserId = adminUserId;
  warning.verifiedAt = new Date();
  warning.verificationNotes = notes;

  return await warning.save();
}

/**
 * Revokes or unpublishes an official warning bulletin.
 */
export async function revokeOfficialWarning({ warningId, adminUserId, reason = "" }) {
  if (!adminUserId) {
    const err = new Error("Authenticated administrator required to revoke official warnings");
    err.statusCode = 401;
    throw err;
  }

  const warning = await OfficialWarning.findById(warningId);
  if (!warning) {
    const err = new Error("Official warning record not found");
    err.statusCode = 404;
    throw err;
  }

  warning.isActive = false;
  warning.verifiedByAdmin = false;
  warning.verificationNotes = `Revoked by admin ${adminUserId}: ${reason}`;

  return await warning.save();
}

/**
 * Lists all warnings for administrator inspection.
 */
export async function getAdminWarnings({ limit = 50 } = {}) {
  if (mongoose.connection.readyState !== 1) {
    return [];
  }
  return await OfficialWarning.find().sort({ createdAt: -1 }).limit(limit).lean();
}

/**
 * Seeds baseline verified official advisories if collection is empty.
 * DISABLED: Official government warnings (BMD/DDM) must strictly originate
 * from verified government bulletins or explicit administrator entry with traceable
 * provenance, NEVER synthetic or unverified startup seeds.
 */
export async function seedInitialOfficialBulletins() {
  // Deliberate no-op to ensure scientific integrity and prevent fabricated official bulletins.
  return { seeded: 0, reason: "Synthetic official warning seeding disabled for integrity." };
}

/**
 * Retrieves active, non-expired, verified official warnings for a given division or district.
 * If no verified bulletin exists, returns an explicit empty array [].
 */
export async function getActiveOfficialWarnings({ division = null, district = null, referenceDate = new Date() } = {}) {
  try {
    if (mongoose.connection.readyState !== 1) {
      return [];
    }

    const query = {
      isActive: true,
      verifiedByAdmin: true,
      validUntil: { $gt: referenceDate },
    };

    if (division) {
      query.affectedDivisions = { $in: [new RegExp(`^${division}$`, "i"), "All", "National"] };
    }

    if (district) {
      query.$or = [
        { affectedDistricts: { $in: [new RegExp(`^${district}$`, "i")] } },
        { affectedDivisions: { $in: [new RegExp(`^${division || ""}$`, "i"), "All", "National"] } },
      ];
    }

    const warnings = await OfficialWarning.find(query).sort({ severity: -1, issuedAt: -1 }).lean();
    const verifiedWarnings = warnings.filter(w => isAuthenticGovernmentBulletin(w, referenceDate));

    return verifiedWarnings.map(w => ({
      id: w._id.toString(),
      bulletinNumber: w.bulletinNumber,
      issuingAuthority: w.issuingAuthority || "Bangladesh Meteorological Department (BMD)",
      sourceType: "OFFICIAL_GOVERNMENT_WARNING",
      isOfficialGovernmentWarning: true,
      hazardType: w.hazardType,
      signalNumber: w.signalNumber,
      severity: w.severity,
      titleEn: w.titleEn,
      titleBn: w.titleBn,
      descriptionEn: w.descriptionEn,
      descriptionBn: w.descriptionBn,
      affectedDivisions: w.affectedDivisions,
      affectedDistricts: w.affectedDistricts,
      actionAdviceEn: w.actionAdviceEn,
      actionAdviceBn: w.actionAdviceBn,
      issuedAt: w.issuedAt,
      validUntil: w.validUntil,
      sourceUrl: w.sourceUrl,
      provenance: "Official Government Warning Bulletin (BMD / DDM)",
    }));
  } catch (err) {
    console.error("Failed to query OfficialWarning:", err.message);
    return [];
  }
}

/**
 * Retrieves expired/historical official warnings for audit and tracking.
 */
export async function getHistoricalOfficialWarnings({ division = null, district = null, limit = 10, referenceDate = new Date() } = {}) {
  try {
    if (mongoose.connection.readyState !== 1) {
      return [];
    }

    const query = {
      validUntil: { $lte: referenceDate },
    };

    if (division) {
      query.affectedDivisions = { $in: [new RegExp(`^${division}$`, "i"), "All", "National"] };
    }

    const warnings = await OfficialWarning.find(query).sort({ validUntil: -1 }).limit(limit).lean();
    return warnings.map(w => ({
      ...w,
      id: w._id.toString(),
      sourceType: "HISTORICAL_OFFICIAL_WARNING",
      isExpired: true,
    }));
  } catch (err) {
    console.error("Failed to query historical OfficialWarning:", err.message);
    return [];
  }
}
