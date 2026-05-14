/**
 * Manual Twilio test: same outbound audio + AMD as failed-payment calls.
 * Does not touch webhooks or failed_payment_calls dedupe.
 *
 * GET /api/test-call?secret=...&to=%2B1...
 * Secret: TWILIO_TEST_CALL_SECRET, or LOGS_SECRET if the former is unset.
 */

const {
  placeTestOutboundCall,
  normalizePhone,
} = require("../lib/failedPaymentCalls");

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

  let toRaw = getToParam(req);
  if (!toRaw && req.method === "POST" && req.body && typeof req.body === "object") {
    const b = req.body;
    if (typeof b.to === "string") toRaw = b.to.trim();
  }

  if (!toRaw) {
    return res.status(400).json({
      ok: false,
      error: "missing_to",
      hint: "Add &to=+15551234567 (URL-encode + as %2B)",
    });
  }

  const preview = normalizePhone(toRaw);
  if (!preview) {
    return res.status(400).json({ ok: false, error: "invalid_to" });
  }

  try {
    const result = await placeTestOutboundCall(toRaw);
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    const msg = e && e.message ? String(e.message) : "call_failed";
    return res.status(400).json({ ok: false, error: msg });
  }
};
