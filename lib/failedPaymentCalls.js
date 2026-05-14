const twilio = require("twilio");
const { getSupabaseAdmin } = require("./supabaseAdmin");

const FAILED_PAYMENT_EVENT_RE = /FAILED[_\s-]?PAYMENT/i;

/** E.164 numbers that must never receive failed-payment voice calls (internal / test lines). */
const DEFAULT_FAILED_PAYMENT_CALL_BLOCKLIST = new Set(["+13039532620"]);

function normalizePhone(input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  if (raw.startsWith("+")) {
    const digits = `+${raw.slice(1).replace(/\D/g, "")}`;
    return digits.length >= 8 ? digits : null;
  }
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

function getFailedPaymentCallBlocklist() {
  const set = new Set(DEFAULT_FAILED_PAYMENT_CALL_BLOCKLIST);
  const raw = (process.env.TWILIO_FAILED_PAYMENT_BLOCKLIST || "").trim();
  if (!raw) return set;
  for (const part of raw.split(/[,;\s]+/)) {
    const n = normalizePhone(part);
    if (n) set.add(n);
  }
  return set;
}

function monthKeyUtc(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function isFailedPaymentEvent(body) {
  const eventType = body && (body.eventType || body.event_type || "");
  return FAILED_PAYMENT_EVENT_RE.test(String(eventType || ""));
}

function getCustomerPhone(body) {
  const candidate = [
    body?.customer?.phone,
    body?.subscription?.shippingAddress?.phone,
    body?.customer?.defaultAddress?.phone,
  ].find(Boolean);
  return normalizePhone(candidate);
}

function getCustomerEmail(body) {
  return body?.customer?.email ? String(body.customer.email) : null;
}

function getSubscriptionId(body) {
  const sid = body?.subscription?.id ?? body?.subscription?.shopifyId;
  return sid ? String(sid) : null;
}

function escapeXmlForPlayUrl(url) {
  return String(url)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * TwiML: plays TWILIO_FAILED_PAYMENT_AUDIO_URL via <Play>.
 * CDATA avoids breaking signed URLs that contain many `&` query pairs (Twilio must fetch the exact URL).
 */
function buildTwiml() {
  const recordingUrl = (process.env.TWILIO_FAILED_PAYMENT_AUDIO_URL || "").trim();
  if (recordingUrl.includes("]]>")) {
    const safe = escapeXmlForPlayUrl(recordingUrl);
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Play>${safe}</Play></Response>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Play><![CDATA[${recordingUrl}]]></Play></Response>`;
}

/**
 * Outbound call options.
 * Default: no AMD — Twilio runs <Play> as soon as the callee answers (fastest; may overlap voicemail greeting).
 * Set TWILIO_AMD_MODE=DetectMessageEnd (+ optional TWILIO_AMD_ASYNC) for voicemail-friendly behavior (slower).
 * @param {{ amdMode?: string }} [overrides] - per-call override; amdMode e.g. "off" or "DetectMessageEnd"
 */
function buildOutboundCallOptions(phone, from, overrides) {
  const o = overrides && typeof overrides === "object" ? overrides : {};
  const opts = {
    to: phone,
    from,
    twiml: buildTwiml(),
  };
  const envAmd = (process.env.TWILIO_AMD_MODE || "off").trim().toLowerCase();
  const amdMode =
    typeof o.amdMode === "string" && o.amdMode.trim() !== ""
      ? o.amdMode.trim().toLowerCase()
      : envAmd;
  if (amdMode !== "off" && amdMode !== "0" && amdMode !== "false") {
    opts.machineDetection = "DetectMessageEnd";
    const timeoutRaw = parseInt(
      (process.env.TWILIO_MACHINE_DETECTION_TIMEOUT || "").trim(),
      10
    );
    if (Number.isFinite(timeoutRaw) && timeoutRaw >= 3 && timeoutRaw <= 59) {
      opts.machineDetectionTimeout = timeoutRaw;
    }

    const asyncRaw = (process.env.TWILIO_AMD_ASYNC || "1").trim().toLowerCase();
    const useAsyncAmd = asyncRaw !== "0" && asyncRaw !== "false" && asyncRaw !== "off";
    if (useAsyncAmd) {
      opts.asyncAmd = true;
      const amdCb = (process.env.TWILIO_AMD_STATUS_CALLBACK_URL || "").trim();
      if (amdCb) {
        opts.asyncAmdStatusCallback = amdCb;
        opts.asyncAmdStatusCallbackMethod = "POST";
      }
    }

    const speechEnd = parseInt(
      (process.env.TWILIO_AMD_SPEECH_END_THRESHOLD_MS || "").trim(),
      10
    );
    if (Number.isFinite(speechEnd) && speechEnd >= 500 && speechEnd <= 5000) {
      opts.machineDetectionSpeechEndThreshold = speechEnd;
    }
    const speechTh = parseInt(
      (process.env.TWILIO_AMD_SPEECH_THRESHOLD_MS || "").trim(),
      10
    );
    if (Number.isFinite(speechTh) && speechTh >= 1000 && speechTh <= 6000) {
      opts.machineDetectionSpeechThreshold = speechTh;
    }
  }
  return opts;
}

function getTwilioClient() {
  const sid = (process.env.TWILIO_ACCOUNT_SID || "").trim();
  const token = (process.env.TWILIO_AUTH_TOKEN || "").trim();
  if (!sid || !token) return null;
  return twilio(sid, token);
}

function isEnabled() {
  return process.env.ENABLE_FAILED_PAYMENT_CALLS === "1";
}

/**
 * Place one outbound test call (same TwiML + AMD as production by default). No Supabase, no blocklist.
 * @param {string} toRaw - destination phone (any common US / E.164 shape)
 * @param {{ amdMode?: string }} [options] - pass { amdMode: "off" } to skip voicemail detection for this call only
 * @returns {Promise<{ callSid: string, to: string, from: string, machineDetection: string | null }>}
 */
async function placeTestOutboundCall(toRaw, options) {
  const phone = normalizePhone(toRaw);
  if (!phone) {
    const err = new Error("invalid_to");
    err.code = "invalid_to";
    throw err;
  }

  const from = (process.env.TWILIO_FROM_NUMBER || "").trim();
  if (!from) {
    const err = new Error("missing_twilio_from_number");
    err.code = "missing_twilio_from_number";
    throw err;
  }

  const client = getTwilioClient();
  if (!client) {
    const err = new Error("missing_twilio_credentials");
    err.code = "missing_twilio_credentials";
    throw err;
  }

  const audioUrl = (process.env.TWILIO_FAILED_PAYMENT_AUDIO_URL || "").trim();
  if (!audioUrl) {
    const err = new Error("missing_twilio_failed_payment_audio_url");
    err.code = "missing_audio_url";
    throw err;
  }

  const callOpts = buildOutboundCallOptions(phone, from, options);
  const call = await client.calls.create(callOpts);
  return {
    callSid: call.sid,
    to: phone,
    from,
    machineDetection: callOpts.machineDetection || null,
  };
}

/**
 * Call once per phone number per month for failed-payment webhooks.
 * Returns:
 * - { skipped: true, reason }
 * - { called: true, sid, phone, monthKey }
 */
async function maybeTriggerFailedPaymentCall(body) {
  if (!isFailedPaymentEvent(body)) return { skipped: true, reason: "not_failed_payment_event" };
  if (!isEnabled()) return { skipped: true, reason: "feature_flag_disabled" };

  const sb = getSupabaseAdmin();
  if (!sb) return { skipped: true, reason: "missing_supabase_env" };

  const phone = getCustomerPhone(body);
  if (!phone) return { skipped: true, reason: "missing_phone" };

  if (getFailedPaymentCallBlocklist().has(phone)) {
    return { skipped: true, reason: "blocked_phone", phone };
  }

  const from = (process.env.TWILIO_FROM_NUMBER || "").trim();
  if (!from) return { skipped: true, reason: "missing_twilio_from_number" };

  const client = getTwilioClient();
  if (!client) return { skipped: true, reason: "missing_twilio_credentials" };

  const audioUrl = (process.env.TWILIO_FAILED_PAYMENT_AUDIO_URL || "").trim();
  if (!audioUrl) return { skipped: true, reason: "missing_audio_url" };

  const monthKey = monthKeyUtc(new Date());
  const eventType = String(body?.eventType || body?.event_type || "SUBSCRIPTION_FAILED_PAYMENT");
  const customerEmail = getCustomerEmail(body);
  const subscriptionId = getSubscriptionId(body);
  const payload = body && typeof body === "object" ? body : {};

  // Monthly dedupe lock: unique(phone_e164, month_key)
  const lockRow = {
    month_key: monthKey,
    phone_e164: phone,
    event_type: eventType,
    customer_email: customerEmail,
    subscription_id: subscriptionId,
    status: "dedupe_locked",
    payload,
  };
  const { error: lockErr } = await sb.from("failed_payment_calls").insert(lockRow);
  if (lockErr) {
    // Postgres unique violation: this phone was already called (or locked) this month.
    if (lockErr.code === "23505") {
      return { skipped: true, reason: "already_called_this_month", phone, monthKey };
    }
    throw lockErr;
  }

  try {
    const call = await client.calls.create(buildOutboundCallOptions(phone, from));

    const { error: updateErr } = await sb
      .from("failed_payment_calls")
      .update({
        status: "called",
        twilio_call_sid: call.sid,
        called_at: new Date().toISOString(),
      })
      .eq("phone_e164", phone)
      .eq("month_key", monthKey);
    if (updateErr) {
      console.warn("[webhook] failed_payment_calls update warning", updateErr.message);
    }

    return { called: true, sid: call.sid, phone, monthKey };
  } catch (e) {
    const { error: failErr } = await sb
      .from("failed_payment_calls")
      .update({
        status: "call_failed",
        error_message: e && e.message ? String(e.message).slice(0, 1000) : "unknown_error",
      })
      .eq("phone_e164", phone)
      .eq("month_key", monthKey);
    if (failErr) {
      console.warn("[webhook] failed_payment_calls failure update warning", failErr.message);
    }
    throw e;
  }
}

module.exports = {
  isFailedPaymentEvent,
  maybeTriggerFailedPaymentCall,
  normalizePhone,
  placeTestOutboundCall,
};
