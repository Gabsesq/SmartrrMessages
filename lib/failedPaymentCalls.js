const twilio = require("twilio");
const { getSupabaseAdmin } = require("./supabaseAdmin");

const FAILED_PAYMENT_EVENT_RE = /FAILED[_\s-]?PAYMENT/i;

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

function buildVoiceMessage(body) {
  const shop = body?.organization?.name || "our store";
  return `Hi, this is an automated billing reminder from ${shop}. We could not process your subscription payment. Please log in to your account to update your payment method. Thank you.`;
}

function buildTwiml(body) {
  const text = buildVoiceMessage(body)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">${text}</Say></Response>`;
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

  const from = (process.env.TWILIO_FROM_NUMBER || "").trim();
  if (!from) return { skipped: true, reason: "missing_twilio_from_number" };

  const client = getTwilioClient();
  if (!client) return { skipped: true, reason: "missing_twilio_credentials" };

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
    const call = await client.calls.create({
      to: phone,
      from,
      twiml: buildTwiml(body),
    });

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
};
