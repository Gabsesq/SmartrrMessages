/**
 * Smartrr Vendor API helper.
 * Token: Smartrr app → Configuration → Integrations → API Keys / Add Key.
 * Docs reference GET selling-plan-group and vendor URLs using header x-smartrr-access-token.
 *
 * Env (set in Vercel → Settings → Environment Variables or local .env — never commit secrets):
 *   SMARTRR_ACCESS_TOKEN   preferred
 *   SMARTRR_API_KEY        alias if you already named it this elsewhere
 */

const SMARTRR_API_BASE = "https://api.smartrr.com";

function getAccessToken() {
  const token =
    process.env.SMARTRR_ACCESS_TOKEN || process.env.SMARTRR_API_KEY || "";
  if (!token.trim()) {
    throw new Error(
      "Missing SMARTRR_ACCESS_TOKEN (or SMARTRR_API_KEY) in environment."
    );
  }
  return token.trim();
}

/**
 * @param {string} path - e.g. "/vendor/selling-plan-group"
 * @param {RequestInit & { query?: Record<string, string | number | boolean> }} [options]
 */
async function smartrrRequest(path, options = {}) {
  const { query, ...fetchInit } = options;
  let urlPath = path.startsWith("/") ? path : `/${path}`;
  let url = `${SMARTRR_API_BASE}${urlPath}`;
  if (query && typeof query === "object") {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const q = qs.toString();
    if (q) url += `?${q}`;
  }

  const headers = {
    Accept: "application/json",
    "x-smartrr-access-token": getAccessToken(),
    ...(fetchInit.headers || {}),
  };

  const body = fetchInit.body;
  const method = fetchInit.method || "GET";
  if (
    body !== undefined &&
    typeof body !== "string" &&
    !(body instanceof Uint8Array) &&
    !(typeof Buffer !== "undefined" && Buffer.isBuffer(body))
  ) {
    headers["Content-Type"] =
      headers["Content-Type"] || headers["content-type"] || "application/json";
    fetchInit.body = JSON.stringify(body);
  }

  const res = await fetch(url, {
    ...fetchInit,
    method,
    headers,
  });

  const text = await res.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* leave as raw text */
  }

  if (!res.ok) {
    const err = new Error(`Smartrr API ${res.status}: ${typeof data === "string" ? data.slice(0, 500) : res.statusText}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }

  return data;
}

/** GET /vendor/selling-plan-group — subscription programs (Headless doc). */
function getSellingPlanGroups(opts = {}) {
  const cache = opts.cache;
  const query =
    cache === undefined ? {} : { cache: cache === true ? "true" : "false" };
  return smartrrRequest("/vendor/selling-plan-group", { query });
}

module.exports = {
  SMARTRR_API_BASE,
  smartrrRequest,
  getSellingPlanGroups,
};
