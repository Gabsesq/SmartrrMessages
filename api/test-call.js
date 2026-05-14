/**
 * Manual Twilio test: same outbound audio + AMD as failed-payment calls.
 * Does not touch webhooks or failed_payment_calls dedupe.
 *
 * JSON: GET/POST /api/test-call?secret=...&to=%2B1...   (to optional if TWILIO_TEST_TO_NUMBER is set)
 * HTML helper: GET /api/test-call?format=html&secret=...
 *
 * Secret: TWILIO_TEST_CALL_SECRET, or LOGS_SECRET if the former is unset.
 */

const {
  placeTestOutboundCall,
  normalizePhone,
} = require("../lib/failedPaymentCalls");

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getProvidedSecret(req) {
  const q = req.query || {};
  return (
    (typeof q.secret === "string" && q.secret) ||
    (typeof req.headers["x-test-call-secret"] === "string" &&
      req.headers["x-test-call-secret"]) ||
    ""
  );
}

function getToParam(req) {
  const q = req.query || {};
  if (typeof q.to === "string" && q.to.trim()) return q.to.trim();
  return null;
}

function resolveToRaw(req) {
  let to = getToParam(req);
  if (!to && req.method === "POST" && req.body && typeof req.body === "object") {
    const b = req.body;
    if (typeof b.to === "string") to = b.to.trim();
  }
  if (!to) to = (process.env.TWILIO_TEST_TO_NUMBER || "").trim();
  return to || null;
}

/** @returns {string | undefined} */
function parseAmdOverride(req) {
  const q = req.query || {};
  const v = typeof q.amd === "string" ? q.amd.trim().toLowerCase() : "";
  if (!v) return undefined;
  if (v === "off" || v === "0" || v === "false") return "off";
  if (v === "detect" || v === "on" || v === "vm" || v === "voicemail") return "DetectMessageEnd";
  return undefined;
}

function buildQueryPath(secret, extra) {
  const p = new URLSearchParams({ secret, ...extra });
  return `/api/test-call?${p.toString()}`;
}

function renderHtmlPage({ secret, toRaw }) {
  const normalized = toRaw ? normalizePhone(toRaw) : null;
  const canPlace = Boolean(normalized);
  const toForLinks = normalized || (toRaw ? String(toRaw).trim() : "");
  const linkExtra = toForLinks ? { to: toForLinks } : {};

  const vmPath = buildQueryPath(secret, { ...linkExtra });
  const humanPath = buildQueryPath(secret, { ...linkExtra, amd: "off" });
  const setupNote = canPlace
    ? `<p>Calling <strong>${escapeHtml(normalized || String(toRaw))}</strong> (from <code>TWILIO_TEST_TO_NUMBER</code> and/or <code>to</code> in the URL).</p>`
    : `<p class="warn">Set <code>TWILIO_TEST_TO_NUMBER</code> in Vercel to your mobile, <strong>or</strong> open this page with <code>&amp;to=%2B1YOURNUMBER</code> (encode <code>+</code> as <code>%2B</code>), then reload.</p>`;

  const buttons = canPlace
    ? `<p>
  <a class="btn" href="${escapeHtml(vmPath)}">Place test call (AMD / voicemail-friendly)</a>
  <a class="btn secondary" href="${escapeHtml(humanPath)}">Place test call (AMD off)</a>
</p>`
    : `<p><span class="btn disabled">Place test call (configure number first)</span></p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Twilio test call</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; max-width: 640px; line-height: 1.45; color: #111; }
  h1 { font-size: 1.25rem; }
  code { background: #f0f0f0; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  .warn { color: #7a2e00; background: #fff4e5; padding: 12px; border-radius: 8px; }
  ol { padding-left: 1.25rem; }
  .btn { display: inline-block; margin: 8px 8px 0 0; padding: 10px 14px; background: #111; color: #fff; text-decoration: none; border-radius: 8px; font-size: 14px; }
  .btn.secondary { background: #444; }
  .btn.disabled { background: #999; cursor: not-allowed; }
  .hint { font-size: 13px; color: #444; margin-top: 20px; }
</style>
</head>
<body>
<h1>Test outbound call (same as failed-payment flow)</h1>
${setupNote}
<ol>
  <li><strong>Live answer</strong> — first button: your MP3 should start almost as soon as you pick up (default: no AMD in production). If you still hear ~7s silence, check Twilio <strong>trial</strong> disclaimer first, then use a smaller / cached MP3.</li>
  <li><strong>Voicemail</strong> — same button, do not answer. With default settings, audio may start during the greeting. For “after the beep”, set <code>TWILIO_AMD_MODE=DetectMessageEnd</code> in Vercel (slower on live answer).</li>
  <li><strong>Optional</strong> — second button forces AMD off for debugging.</li>
</ol>
${buttons}
<p class="hint">Twilio trial accounts may only call <a href="https://www.twilio.com/docs/usage/tutorials/how-to-use-your-free-trial-account">verified numbers</a>. Check the JSON response or Twilio call logs if it fails.</p>
</body>
</html>`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  const expected = (
    process.env.TWILIO_TEST_CALL_SECRET ||
    process.env.LOGS_SECRET ||
    ""
  ).trim();
  const provided = getProvidedSecret(req).trim();

  if (!expected || provided !== expected) {
    return res.status(401).json({
      ok: false,
      error: "unauthorized",
      hint: "Set TWILIO_TEST_CALL_SECRET (or LOGS_SECRET) and pass ?secret=...",
    });
  }

  const q = req.query || {};
  const wantHtml =
    typeof q.format === "string" && q.format.trim().toLowerCase() === "html";

  const toRaw = resolveToRaw(req);

  if (wantHtml) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(renderHtmlPage({ secret: provided, toRaw }));
  }

  if (!toRaw) {
    return res.status(400).json({
      ok: false,
      error: "missing_to",
      hint:
        "Set TWILIO_TEST_TO_NUMBER in Vercel, or add &to=%2B15551234567 (encode +). Open ?format=html&secret=... for a click-to-call page.",
    });
  }

  if (!normalizePhone(toRaw)) {
    return res.status(400).json({ ok: false, error: "invalid_to" });
  }

  const amdOverride = parseAmdOverride(req);
  const callOptions = amdOverride !== undefined ? { amdMode: amdOverride } : {};

  try {
    const result = await placeTestOutboundCall(toRaw, callOptions);
    return res.status(200).json({
      ok: true,
      ...result,
      hint:
        "Voicemail: run again and let it ring through. Pickup: answer on first ring. machineDetection null means AMD off for this call.",
    });
  } catch (e) {
    const msg = e && e.message ? String(e.message) : "call_failed";
    return res.status(400).json({ ok: false, error: msg });
  }
};
