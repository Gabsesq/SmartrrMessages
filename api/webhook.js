/**
 * Smartrr (or any) POST webhook capture for Vercel.
 * - Logs full payload + selected headers to Vercel → Project → Logs.
 * - Optionally POSTs every received body to FORWARD_URL (second hop).
 *
 * Env:
 *   FORWARD_URL          — if set, every POST is forwarded here (full original + metadata)
 *   NOTE_MIN_LENGTH      — min characters for noteCandidates heuristic (default 15)
 *   SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL  — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY               — service role (server only); inserts into webhook_events
 *   ENABLE_FAILED_PAYMENT_CALLS             — "1" enables Twilio calls for failed-payment events
 *   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER
 */

const { persistWebhookRow } = require("../lib/persistWebhook");
const { maybeTriggerFailedPaymentCall } = require("../lib/failedPaymentCalls");

function tryParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      const raw = req.body.toString("utf8");
      const parsed = tryParseJson(raw);
      resolve(parsed != null ? parsed : { _rawText: raw });
      return;
    }
    if (req.body != null && typeof req.body === "object" && Object.keys(req.body).length > 0) {
      resolve(req.body);
      return;
    }
    if (typeof req.body === "string" && req.body.length > 0) {
      const parsed = tryParseJson(req.body);
      resolve(parsed != null ? parsed : { _rawText: req.body });
      return;
    }
    if (typeof req.on !== "function") {
      resolve({ _readBodyError: "not_a_node_stream_request" });
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      const parsed = tryParseJson(raw);
      resolve(parsed != null ? parsed : { _rawText: raw });
    });
    req.on("error", reject);
  });
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch (e) {
    return JSON.stringify({
      error: "json_stringify_failed",
      message: e && e.message,
    });
  }
}

const NOTE_KEY_RE =
  /(note|message|reason|comment|feedback|detail|explanation|custom|text|cancellation)/i;

function collectStrings(obj, out, depth = 0) {
  if (depth > 12 || obj == null) return;
  if (typeof obj === "string") {
    out.push(obj);
    return;
  }
  if (Array.isArray(obj)) {
    for (const x of obj) collectStrings(x, out, depth + 1);
    return;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") {
        out.push({ key: k, value: v });
      } else {
        collectStrings(v, out, depth + 1);
      }
    }
  }
}

function findLikelyNote(body, minLen) {
  const items = [];
  collectStrings(body, items);
  const candidates = [];
  for (const item of items) {
    if (typeof item === "string") {
      if (item.trim().length >= minLen) candidates.push({ key: "(nested)", value: item.trim() });
      continue;
    }
    const { key, value } = item;
    if (typeof value !== "string" || value.trim().length < minLen) continue;
    const t = value.trim();
    if (NOTE_KEY_RE.test(key)) {
      candidates.push({ key, value: t });
    }
  }
  if (candidates.length) return candidates;
  for (const item of items) {
    if (typeof item === "object" && item && typeof item.value === "string") {
      const t = item.value.trim();
      if (t.length >= minLen) candidates.push({ key: item.key, value: t });
    }
  }
  return candidates;
}

module.exports = async function handler(req, res) {
  // Log every hit — GET used to exit with no logs, so browser checks looked "dead" in Vercel.
  console.log(
    "[webhook] request",
    safeStringify({
      at: new Date().toISOString(),
      method: req.method,
      url: req.url,
      host: req.headers.host,
    })
  );

  if (req.method === "GET") {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send("POST Smartrr webhooks here. Logs appear in Vercel → Logs.");
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  console.log(
    "[webhook] POST received",
    safeStringify({
      at: new Date().toISOString(),
      url: req.url,
      host: req.headers.host,
      "content-type": req.headers["content-type"],
      "content-length": req.headers["content-length"],
      "user-agent": req.headers["user-agent"],
    })
  );

  try {
    const body = await readBody(req);
    const minLen = Math.max(1, parseInt(process.env.NOTE_MIN_LENGTH || "15", 10) || 15);
    const noteHits = findLikelyNote(body, minLen);
    const forwardUrl = (process.env.FORWARD_URL || "").trim();

    const logPayload = {
      at: new Date().toISOString(),
      headers: {
        "content-type": req.headers["content-type"],
        "user-agent": req.headers["user-agent"],
        "x-forwarded-for": req.headers["x-forwarded-for"],
        "x-smartrr-signature": req.headers["x-smartrr-signature"] || req.headers["x-webhook-signature"],
      },
      noteCandidates: noteHits,
      body,
    };

    console.log("[webhook] payload", safeStringify(logPayload));

    let stored = false;
    try {
      const pr = await persistWebhookRow(body, req.headers);
      stored = pr.saved === true;
      if (pr.skipped) {
        console.warn("[webhook] DB skipped (missing SUPABASE_* env)");
      }
    } catch (dbErr) {
      console.error("[webhook] DB persist error", dbErr && dbErr.message);
    }

    let failedPaymentCall = { skipped: true, reason: "not_attempted" };
    try {
      failedPaymentCall = await maybeTriggerFailedPaymentCall(body);
      if (failedPaymentCall.called) {
        console.log("[webhook] failed-payment call placed", safeStringify(failedPaymentCall));
      } else if (!failedPaymentCall.skipped) {
        console.log("[webhook] failed-payment call result", safeStringify(failedPaymentCall));
      }
    } catch (callErr) {
      failedPaymentCall = { skipped: true, reason: "call_error" };
      console.error("[webhook] failed-payment call error", callErr && callErr.message);
    }

    let forwarded = false;
    if (forwardUrl) {
      try {
        const r = await fetch(forwardUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: "smartrr-message",
            receivedAt: logPayload.at,
            noteCandidates: noteHits,
            original: body,
          }),
        });
        forwarded = r.ok;
        if (!r.ok) {
          console.warn("[webhook] forward failed", r.status, await r.text());
        }
      } catch (e) {
        console.warn("[webhook] forward error", e && e.message);
      }
    }

    return res.status(200).json({
      ok: true,
      noteCandidates: noteHits.length,
      forwarded,
      stored,
      failedPaymentCall,
    });
  } catch (e) {
    console.error("[webhook] handler error", e && e.message, e && e.stack);
    return res.status(500).json({ ok: false, error: "handler_error" });
  }
}
