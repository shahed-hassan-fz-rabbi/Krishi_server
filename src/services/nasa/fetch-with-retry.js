const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function retryAfterMilliseconds(response) {
  const value = response.headers?.get?.("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/** Bounded NASA HTTP retry. Authentication and other permanent 4xx responses fail immediately. */
export async function fetchWithRetry(url, init = {}, options = {}) {
  const {
    attempts = 3,
    baseDelayMs = 300,
    maxDelayMs = 3000,
    fetchImpl = globalThis.fetch,
    sleepImpl = sleep,
  } = options;

  if (!Number.isInteger(attempts) || attempts < 1 || typeof fetchImpl !== "function") {
    throw new TypeError("fetchWithRetry requires at least one attempt and a fetch implementation");
  }

  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) throw error;
    }

    if (response) {
      if (!RETRYABLE_STATUS.has(response.status) || attempt === attempts - 1) return response;
      lastError = new Error(`Retryable NASA HTTP response ${response.status}`);
    }

    const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
    const retryAfter = response ? retryAfterMilliseconds(response) : null;
    await sleepImpl(Math.min(maxDelayMs, retryAfter ?? exponentialDelay));
  }

  throw lastError || new Error("NASA request failed after bounded retries");
}
