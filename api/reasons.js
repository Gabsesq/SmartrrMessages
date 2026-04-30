const { smartrrRequest } = require("../lib/smartrrClient");

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getReasonLabel(textObj) {
  if (!textObj || typeof textObj !== "object") return "";
  if (textObj["en-US"]) return String(textObj["en-US"]);
  const first = Object.values(textObj)[0];
  return first == null ? "" : String(first);
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const reasons = await smartrrRequest("/vendor/cancellation-reasons");
    const rows = (Array.isArray(reasons) ? reasons : []).map((r) => {
      const label = getReasonLabel(r.text);
      return `
<tr>
  <td>${escapeHtml(r.id || "")}</td>
  <td>${escapeHtml(label)}</td>
  <td>${escapeHtml(r.reasonType || "")}</td>
  <td>${escapeHtml(r.action || "")}</td>
  <td>${escapeHtml(String(r.uiIdx ?? ""))}</td>
  <td>${escapeHtml(String(r.hasCustomerPrompt ?? ""))}</td>
  <td>${escapeHtml(String(r.isArchived ?? ""))}</td>
  <td>${escapeHtml(String(r.discount ?? ""))}</td>
</tr>
<tr class="detail-row">
  <td colspan="8">
    <details>
      <summary>Raw JSON</summary>
      <pre>${escapeHtml(JSON.stringify(r, null, 2))}</pre>
    </details>
  </td>
</tr>`;
    });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Smartrr Cancellation Reasons</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 24px; background: #fafafa; color: #111; }
    h1 { font-size: 1.3rem; margin-bottom: 8px; }
    .hint { color: #555; margin: 0 0 16px; }
    table { border-collapse: collapse; width: 100%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    th, td { border: 1px solid #ddd; padding: 8px 10px; font-size: 13px; vertical-align: top; }
    th { background: #f0f0f0; text-align: left; }
    pre { white-space: pre-wrap; word-break: break-word; font-size: 12px; margin: 8px 0 0; }
    .detail-row td { border-top: none; background: #fcfcfc; }
  </style>
</head>
<body>
  <h1>Smartrr Cancellation Reasons</h1>
  <p class="hint">Total reasons: <strong>${rows.length}</strong>. Use <code>hasCustomerPrompt</code> to see whether a typed prompt is enabled for that reason.</p>
  <table>
    <thead>
      <tr>
        <th>ID</th>
        <th>Label</th>
        <th>Reason Type</th>
        <th>Action</th>
        <th>UI Index</th>
        <th>Has Prompt</th>
        <th>Archived</th>
        <th>Discount</th>
      </tr>
    </thead>
    <tbody>
      ${rows.join("\n") || `<tr><td colspan="8">No reasons found.</td></tr>`}
    </tbody>
  </table>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(html);
  } catch (e) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res
      .status(500)
      .send(`Failed to fetch cancellation reasons: ${e && e.message ? e.message : "unknown_error"}`);
  }
};
