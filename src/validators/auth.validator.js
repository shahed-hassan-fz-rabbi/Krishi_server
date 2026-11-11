const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function normalizePhone(value) {
  if (typeof value !== "string") return "";
  const digits = value.trim().replace(/[০-৯]/g, c => String("০১২৩৪৫৬৭৮৯".indexOf(c))).replace(/[\s()-]/g, "");
  const local = digits.replace(/^(?:\+880|00880|880)/, "0");
  return /^01[3-9]\d{8}$/.test(local) ? `+88${local}` : "";
}
function contactFields(body, errors) {
  const identifier = typeof body.identifier === "string" ? body.identifier.trim() : "";
  const email = identifier ? (identifier.includes("@") ? identifier.toLowerCase() : "") : typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const rawPhone = identifier && !identifier.includes("@") ? identifier : body.phone;
  const phone = normalizePhone(rawPhone);
  if (email && !EMAIL_REGEX.test(email)) errors.push("A valid email address is required");
  if (rawPhone && !phone) errors.push("A valid Bangladesh mobile number is required");
  if (!email && !phone && !rawPhone) errors.push("A valid email address or phone number is required");
  return { ...(email ? { email } : {}), ...(phone ? { phone } : {}) };
}
const ALLOWED_DISTRICTS = ["chattogram", "cumilla"];

/**
 * Validates registration input payload.
 * Enforces role restriction: public registrations are ALWAYS 'farmer'.
 */
export function validateRegisterInput(body) {
  const errors = [];

  if (!body || typeof body !== "object") {
    return {
      isValid: false,
      errors: ["Request body must be a valid JSON object"],
      sanitized: null,
    };
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length < 2) {
    errors.push("Name is required and must be at least 2 characters");
  } else if (name.length > 80) {
    errors.push("Name cannot exceed 80 characters");
  }

  const contact = contactFields(body, errors);

  const password = typeof body.password === "string" ? body.password : "";
  if (!password || password.length < 8) {
    errors.push("Password must be at least 8 characters long");
  }

  let preferredDistrict = "chattogram";
  if (body.preferredDistrict !== undefined) {
    const dist = String(body.preferredDistrict).trim().toLowerCase();
    if (!ALLOWED_DISTRICTS.includes(dist)) {
      errors.push("preferredDistrict must be either 'chattogram' or 'cumilla'");
    } else {
      preferredDistrict = dist;
    }
  }

  // NOTE: If body contains role or any attempt to escalate privilege,
  // we strictly ignore it and enforce role = 'farmer'
  return {
    isValid: errors.length === 0,
    errors,
    sanitized: errors.length === 0 ? {
      name,
      ...contact,
      password,
      preferredDistrict,
      role: "farmer",
    } : null,
  };
}

/**
 * Validates login input payload.
 */
export function validateLoginInput(body) {
  const errors = [];

  if (!body || typeof body !== "object") {
    return {
      isValid: false,
      errors: ["Request body must be a valid JSON object"],
      sanitized: null,
    };
  }

  const contact = contactFields(body, errors);

  const password = typeof body.password === "string" ? body.password : "";
  if (!password) {
    errors.push("Password is required");
  }

  return {
    isValid: errors.length === 0,
    errors,
    sanitized: errors.length === 0 ? { ...contact, password } : null,
  };
}

/**
 * Validates profile/district update payload.
 */
export function validateProfileUpdateInput(body) {
  const errors = [];
  const updates = {};

  if (!body || typeof body !== "object") {
    return {
      isValid: false,
      errors: ["Request body must be a valid JSON object"],
      sanitized: null,
    };
  }

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (name.length < 2 || name.length > 80) {
      errors.push("Name must be between 2 and 80 characters");
    } else {
      updates.name = name;
    }
  }

  if (body.preferredDistrict !== undefined) {
    const dist = String(body.preferredDistrict).trim().toLowerCase();
    if (!ALLOWED_DISTRICTS.includes(dist)) {
      errors.push("preferredDistrict must be either 'chattogram' or 'cumilla'");
    } else {
      updates.preferredDistrict = dist;
    }
  }

  if (Object.keys(updates).length === 0 && errors.length === 0) {
    errors.push("At least one valid field to update must be provided");
  }

  return {
    isValid: errors.length === 0,
    errors,
    sanitized: errors.length === 0 ? updates : null,
  };
}
