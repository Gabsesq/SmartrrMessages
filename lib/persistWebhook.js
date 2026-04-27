const { getSupabaseAdmin } = require("./supabaseAdmin");

function deriveWebhookColumns(body) {
  const o = body && typeof body === "object" ? body : {};
  const eventType = o.eventType ?? o.event_type ?? null;
  let subscriptionId = null;
  let customerEmail = null;
  if (o.subscription && typeof o.subscription === "object") {
    const sid = o.subscription.id ?? o.subscription.shopifyId;
    if (sid != null && sid !== "") subscriptionId = String(sid);
  }
  if (o.customer && typeof o.customer === "object" && o.customer.email) {
    customerEmail = String(o.customer.email);
  }
  return { eventType, subscriptionId, customerEmail };
}

function pickRequestHeaders(h) {
  if (!h || typeof h !== "object") return {};
  const keys = [
    "content-type",
    "user-agent",
    "x-forwarded-for",
    "x-smartrr-signature",
    "x-webhook-signature",
  ];
  const out = {};
  for (const k of keys) {
    const v = h[k] ?? h[k.toLowerCase()];
    if (v != null && v !== "") out[k] = Array.isArray(v) ? v[0] : String(v);
  }
  return out;
}

/**
 * Insert webhook payload into Supabase table `webhook_events`.
 * Returns { saved: true } | { skipped: true } — throws on insert failure.
 */
async function persistWebhookRow(body, reqHeaders) {
  const sb = getSupabaseAdmin();
  if (!sb) return { skipped: true };

  const { eventType, subscriptionId, customerEmail } =
    deriveWebhookColumns(body);

  const row = {
    event_type: eventType,
    subscription_id: subscriptionId,
    customer_email: customerEmail,
    payload: body,
    request_headers: pickRequestHeaders(reqHeaders),
  };

  const { error } = await sb.from("webhook_events").insert(row);
  if (error) throw error;
  return { saved: true };
}

module.exports = {
  persistWebhookRow,
  deriveWebhookColumns,
};
