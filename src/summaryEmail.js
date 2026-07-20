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
      text: message
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
    "Failures:",
    ...formatRows(summary.failures, "No failures."),
    "",
    "Recent updates:",
    ...formatRows(summary.recent, "No sync activity.")
  ];
  return `${lines.join("\n")}\n`;
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
