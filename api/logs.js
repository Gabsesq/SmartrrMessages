const { getSupabaseAdmin } = require("../lib/supabaseAdmin");

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).send("Method Not Allowed");
  }

  const expected = (process.env.LOGS_SECRET || "").trim();
  const provided =
    (typeof req.query.secret === "string" && req.query.secret) ||
    (typeof req.headers["x-logs-secret"] === "string" &&
      req.headers["x-logs-secret"]);

  if (!expected || provided !== expected) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(401).send("Unauthorized");
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(500).send(
      "<p>Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.</p>"
    );
  }

  const limitRaw = parseInt(req.query.limit || "100", 10);
  const limit = Math.min(500, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 100));

  const { data: rows, error } = await sb
    .from("webhook_events")
    .select(
      "id,received_at,event_type,subscription_id,customer_email,payload,request_headers"
    )
    .order("received_at", { ascending: false })
    .limit(limit);

  if (error) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(500).send(error.message || "query_failed");
  }

  const rowsHtml = (rows || [])
    .map((r) => {
      const preview =
        typeof r.payload === "object" && r.payload !== null
          ? JSON.stringify(r.payload).slice(0, 280)
          : String(r.payload ?? "");
      const fullJson =
        typeof r.payload === "object" && r.payload !== null
          ? JSON.stringify(r.payload, null, 2)
          : String(r.payload ?? "");
      return `
<tr>
  <td>${escapeHtml(r.received_at || "")}</td>
  <td>${escapeHtml(r.event_type || "")}</td>
  <td>${escapeHtml(r.customer_email || "")}</td>
  <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(r.subscription_id || "")}</td>
  <td style="max-width:280px;font-size:12px;color:#444">${escapeHtml(preview)}${preview.length >= 280 ? "…" : ""}</td>
</tr>
<tr class="detail-row">
  <td colspan="5">
    <details>
      <summary>Full payload</summary>
      <pre>${escapeHtml(fullJson)}</pre>
    </details>
    ${
      r.request_headers && typeof r.request_headers === "object"
        ? `<details><summary>Headers</summary><pre>${escapeHtml(JSON.stringify(r.request_headers, null, 2))}</pre></details>`
        : ""
    }
  </td>
</tr>`;
    })
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Webhook events</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; background: #fafafa; color: #111; }
  h1 { font-size: 1.25rem; }
  table { border-collapse: collapse; width: 100%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  th, td { border: 1px solid #ddd; padding: 8px 10px; vertical-align: top; font-size: 13px; }
  th { background: #f0f0f0; text-align: left; }
  pre { white-space: pre-wrap; word-break: break-word; font-size: 12px; margin: 8px 0 0; }
  details { margin-top: 8px; }
  .detail-row td { border-top: none; background: #fcfcfc; }
  .hint { font-size: 13px; color: #555; margin-bottom: 16px; max-width: 720px; }
</style>
</head>
<body>
<h1>Stored webhook events</h1>
<p class="hint">Showing last <strong>${limit}</strong> rows from <code>webhook_events</code>. Contains <strong>PII</strong> — keep this URL secret.</p>
<table>
  <thead>
    <tr>
      <th>Received (UTC)</th>
      <th>Event</th>
      <th>Customer email</th>
      <th>Subscription id</th>
      <th>Preview</th>
    </tr>
  </thead>
  <tbody>
    ${rowsHtml || `<tr><td colspan="5">No rows yet.</td></tr>`}
  </tbody>
</table>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(html);
};
