import nodemailer from "nodemailer";
import { logger } from "./logger.js";

const DEFAULT_TIMEZONE = "America/New_York";
let lastMissingConfigLogKey = "";

export async function maybeSendDailySummary({ db, config, now = new Date(), transporter = null } = {}) {
  const emailConfig = config.summaryEmail;
  if (!emailConfig?.enabled) return { sent: false, reason: "disabled" };

  const timezone = emailConfig.timezone || DEFAULT_TIMEZONE;
  const localNow = getZonedParts(now, timezone);
  const summaryDate = formatDate(localNow);
  if (!isDue(localNow, emailConfig.time || "23:55")) {
    return { sent: false, reason: "not_due" };
  }

  const existing = await db.getDailySummaryEmail(summaryDate);
  if (existing?.status === "sent") {
    return { sent: false, reason: "already_sent" };
  }

  const missing = missingEmailConfig(emailConfig);
  if (missing.length) {
    const logKey = `${summaryDate}:${missing.join(",")}`;
    if (lastMissingConfigLogKey !== logKey) {
      logger.warn("Daily summary email skipped", { summaryDate, missing: missing.join(",") });
      lastMissingConfigLogKey = logKey;
    }
    return { sent: false, reason: "missing_config", missing };
  }

  const range = dayRangeUtc(summaryDate, timezone);
  const summary = await db.getDailySummary(range);
  const message = buildSummaryMessage({
    summaryDate,
    timezone,
    range,
    summary
  });
  const html = buildSummaryHtml({
    summaryDate,
    timezone,
    range,
    summary
  });

  const mailer = transporter || nodemailer.createTransport({
    host: emailConfig.smtp.host,
    port: emailConfig.smtp.port,
    secure: emailConfig.smtp.secure,
    auth: emailConfig.smtp.user
      ? { user: emailConfig.smtp.user, pass: emailConfig.smtp.password }
      : undefined
  });

  try {
    await mailer.sendMail({
      from: emailConfig.from,
      to: emailConfig.to,
      subject: `Square Sync Daily Recap - ${summaryDate}`,
      text: message,
      html
    });
    await db.markDailySummaryEmail({
      summaryDate,
      recipient: emailConfig.to,
      status: "sent",
      sentAt: new Date()
    });
    logger.info("Daily summary email sent", { summaryDate, recipient: emailConfig.to });
    return { sent: true, summaryDate };
  } catch (error) {
    await db.markDailySummaryEmail({
      summaryDate,
      recipient: emailConfig.to,
      status: "failed",
      lastError: String(error?.stack || error?.message || error).slice(0, 5000)
    });
    logger.error("Daily summary email failed", { summaryDate, error });
    return { sent: false, reason: "send_failed", error };
  }
}

export function buildSummaryMessage({ summaryDate, timezone, range, summary }) {
  const product = summary.products || {};
  const activity = buildActivityRows(summary.activity || summary.recent || [], timezone);
  const lines = [
    `Square Sync Daily Recap`,
    `Date: ${summaryDate} (${timezone})`,
    `Window: ${formatDateTime(range.startUtc, timezone)} to ${formatDateTime(range.endUtc, timezone)}`,
    "",
    `Totals: ${Number(product.event_count || 0)} events, ${Number(product.sku_count || 0)} products, ${Number(product.result_count || 0)} marketplace/database updates`,
    "",
    "Square webhook events:",
    ...formatCounts(summary.events, "status"),
    "",
    "Sync results:",
    ...formatMarketplaceCounts(summary.results),
    "",
    "Sync activity:",
    ...formatActivityTable(activity),
    "",
    "Failures:",
    ...formatRows(summary.failures, "No failures.")
  ];
  return `${lines.join("\n")}\n`;
}

export function buildSummaryHtml({ summaryDate, timezone, range, summary }) {
  const product = summary.products || {};
  const activity = buildActivityRows(summary.activity || summary.recent || [], timezone);
  const failureRows = summary.failures || [];
  return `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; color: #222; line-height: 1.35;">
    <h2 style="margin: 0 0 8px;">Square Sync Daily Recap</h2>
    <p style="margin: 0 0 12px;">
      <strong>Date:</strong> ${escapeHtml(summaryDate)} (${escapeHtml(timezone)})<br>
      <strong>Window:</strong> ${escapeHtml(formatDateTime(range.startUtc, timezone))} to ${escapeHtml(formatDateTime(range.endUtc, timezone))}<br>
      <strong>Totals:</strong> ${Number(product.event_count || 0)} events, ${Number(product.sku_count || 0)} products, ${Number(product.result_count || 0)} marketplace/database updates
    </p>
    ${htmlCounts("Square webhook events", summary.events, "status")}
    ${htmlMarketplaceCounts("Sync results", summary.results)}
    <h3 style="margin: 16px 0 8px;">Sync Activity</h3>
    ${htmlActivityTable(activity)}
    <h3 style="margin: 16px 0 8px;">Failures</h3>
    ${htmlFailures(failureRows)}
  </body>
</html>`;
}

export function dayRangeUtc(summaryDate, timezone = DEFAULT_TIMEZONE) {
  const [year, month, day] = summaryDate.split("-").map((value) => Number.parseInt(value, 10));
  return {
    startUtc: zonedTimeToUtc({ year, month, day, hour: 0, minute: 0, second: 0, timezone }),
    endUtc: zonedTimeToUtc({ year, month, day: day + 1, hour: 0, minute: 0, second: 0, timezone })
  };
}

function formatCounts(rows, key) {
  if (!rows?.length) return ["  none"];
  return rows.map((row) => `  ${row[key]}: ${Number(row.count || 0)}`);
}

function formatMarketplaceCounts(rows) {
  if (!rows?.length) return ["  none"];
  return rows.map((row) => `  ${row.marketplace}: ${row.status} ${Number(row.count || 0)}`);
}

function formatRows(rows, emptyText) {
  if (!rows?.length) return [`  ${emptyText}`];
  return rows.map((row) => {
    const product = [row.sku, row.item_name, row.variant_name, row.vendor].filter(Boolean).join(" | ");
    const details = row.message ? ` details=${row.message}` : "";
    return `  ${row.marketplace}: ${row.status} set to ${row.quantity ?? "?"} ${product}${details}`;
  });
}

function buildActivityRows(rows, timezone) {
  const services = ["local", "shopify:strawberry", "shopify:nwt", "walmart", "amazon"];
  const groups = new Map();
  for (const row of rows || []) {
    const key = `${row.event_id || ""}:${row.sku || ""}`;
    const existing = groups.get(key) || {
      eventId: row.event_id,
      sku: row.sku,
      description: describeSummaryItem(row),
      quantity: row.quantity,
      createdAt: row.created_at,
      services: {}
    };
    if (!existing.description || existing.description === "unknown item") {
      existing.description = describeSummaryItem(row);
    }
    if (row.created_at && (!existing.createdAt || new Date(row.created_at) > new Date(existing.createdAt))) {
      existing.createdAt = row.created_at;
    }
    existing.quantity = row.quantity ?? existing.quantity;
    existing.services[row.marketplace] = serviceStatus(row);
    groups.set(key, existing);
  }

  return [...groups.values()]
    .sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0))
    .map((row) => {
      const parts = getZonedParts(new Date(row.createdAt), timezone);
      return {
        ...row,
        date: formatDate(parts),
        time: `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`,
        database: row.services.local || "",
        strawberry: row.services["shopify:strawberry"] || "",
        nwt: row.services["shopify:nwt"] || "",
        walmart: row.services.walmart || "",
        amazon: row.services.amazon || "",
        serviceOrder: services
      };
    });
}

function formatActivityTable(rows) {
  if (!rows.length) return ["  No sync activity."];
  const headers = ["SKU", "Desc", "Qty", "Date", "Time", "DB", "Strawberry", "NWT", "Walmart", "Amazon"];
  const data = rows.map((row) => [
    row.sku || "",
    truncate(row.description || "", 42),
    row.quantity ?? "",
    row.date || "",
    row.time || "",
    row.database,
    row.strawberry,
    row.nwt,
    row.walmart,
    row.amazon
  ]);
  return formatTextTable(headers, data);
}

function formatTextTable(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.min(42, Math.max(header.length, ...rows.map((row) => String(row[index] ?? "").length)))
  );
  const line = widths.map((width) => "-".repeat(width)).join("-+-");
  return [
    headers.map((header, index) => padCell(header, widths[index])).join(" | "),
    line,
    ...rows.map((row) => row.map((cell, index) => padCell(cell, widths[index])).join(" | "))
  ];
}

function padCell(value, width) {
  const text = truncate(String(value ?? ""), width);
  return text.padEnd(width, " ");
}

function serviceStatus(row) {
  if (row.status === "success") return "yes";
  if (row.status === "skipped") return "skip";
  if (row.status === "failed") return "no";
  return row.status || "";
}

function describeSummaryItem(row) {
  return [row.item_name, row.variant_name, row.vendor].filter(Boolean).join(" | ") || "unknown item";
}

function htmlCounts(title, rows, key) {
  const items = rows?.length
    ? rows.map((row) => `<li>${escapeHtml(row[key])}: ${Number(row.count || 0)}</li>`).join("")
    : "<li>none</li>";
  return `<h3 style="margin: 16px 0 4px;">${escapeHtml(title)}</h3><ul style="margin-top: 0;">${items}</ul>`;
}

function htmlMarketplaceCounts(title, rows) {
  const items = rows?.length
    ? rows.map((row) => `<li>${escapeHtml(row.marketplace)}: ${escapeHtml(row.status)} ${Number(row.count || 0)}</li>`).join("")
    : "<li>none</li>";
  return `<h3 style="margin: 16px 0 4px;">${escapeHtml(title)}</h3><ul style="margin-top: 0;">${items}</ul>`;
}

function htmlActivityTable(rows) {
  if (!rows.length) return `<p>No sync activity.</p>`;
  const headers = ["SKU", "Desc", "Qty", "Date", "Time", "DB", "Strawberry", "NWT", "Walmart", "Amazon"];
  const body = rows.map((row) => `
      <tr>
        <td>${escapeHtml(row.sku || "")}</td>
        <td>${escapeHtml(row.description || "")}</td>
        <td>${escapeHtml(row.quantity ?? "")}</td>
        <td>${escapeHtml(row.date || "")}</td>
        <td>${escapeHtml(row.time || "")}</td>
        <td>${escapeHtml(row.database)}</td>
        <td>${escapeHtml(row.strawberry)}</td>
        <td>${escapeHtml(row.nwt)}</td>
        <td>${escapeHtml(row.walmart)}</td>
        <td>${escapeHtml(row.amazon)}</td>
      </tr>`).join("");
  return `<table cellpadding="6" cellspacing="0" border="1" style="border-collapse: collapse; font-size: 13px;">
    <thead><tr>${headers.map((header) => `<th align="left">${escapeHtml(header)}</th>`).join("")}</tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function htmlFailures(rows) {
  if (!rows.length) return `<p>No failures.</p>`;
  const body = rows.map((row) => `
    <tr>
      <td>${escapeHtml(row.sku || "")}</td>
      <td>${escapeHtml(describeSummaryItem(row))}</td>
      <td>${escapeHtml(row.marketplace || "")}</td>
      <td>${escapeHtml(row.quantity ?? "")}</td>
      <td>${escapeHtml(row.message || "")}</td>
    </tr>`).join("");
  return `<table cellpadding="6" cellspacing="0" border="1" style="border-collapse: collapse; font-size: 13px;">
    <thead><tr><th align="left">SKU</th><th align="left">Desc</th><th align="left">Service</th><th align="left">Qty</th><th align="left">Details</th></tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(value, maxLength) {
  const text = String(value ?? "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function missingEmailConfig(emailConfig) {
  const missing = [];
  if (!emailConfig.from) missing.push("SUMMARY_EMAIL_FROM");
  if (!emailConfig.to) missing.push("SUMMARY_EMAIL_TO");
  if (!emailConfig.smtp.host) missing.push("SMTP_HOST");
  if (emailConfig.smtp.user && !emailConfig.smtp.password) missing.push("SMTP_PASSWORD");
  return missing;
}

function isDue(localParts, sendTime) {
  const [hour, minute] = String(sendTime || "23:55").split(":").map((value) => Number.parseInt(value, 10));
  const dueMinutes = (Number.isFinite(hour) ? hour : 23) * 60 + (Number.isFinite(minute) ? minute : 55);
  return localParts.hour * 60 + localParts.minute >= dueMinutes;
}

function formatDate(parts) {
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function formatDateTime(date, timezone) {
  const parts = getZonedParts(date, timezone);
  return `${formatDate(parts)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

function getZonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function zonedTimeToUtc({ year, month, day, hour, minute, second, timezone }) {
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let utc = target;
  for (let i = 0; i < 3; i += 1) {
    const parts = getZonedParts(new Date(utc), timezone);
    const current = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    utc -= current - target;
  }
  return new Date(utc);
}

function pad(value) {
  return String(value).padStart(2, "0");
}
