import nodemailer from "nodemailer";
import { logger } from "./logger.js";
import {
  getSquareQuantitiesByCatalogObject,
  normalizeCatalogVariations,
  retrieveCatalogObject,
  searchChangedCatalogObjectPages,
} from "./square.js";

const DEFAULT_TIMEZONE = "America/New_York";

export async function maybeRunCatalogReconciliation({ db, config, now = new Date(), transporter = null } = {}) {
  const reconcileConfig = config.reconciliation || {};
  if (!reconcileConfig.enabled) return { ran: false, reason: "disabled" };

  const timezone = reconcileConfig.timezone || DEFAULT_TIMEZONE;
  const localNow = getZonedParts(now, timezone);
  const runDate = formatDate(localNow);
  if (!isDue(localNow, reconcileConfig.time || "07:00")) {
    return { ran: false, reason: "not_due" };
  }

  const existing = await db.getReconciliationRun?.(runDate);
  if (existing?.status === "sent" || existing?.status === "completed" || existing?.status === "running") {
    return { ran: false, reason: `already_${existing.status}` };
  }

  return runCatalogReconciliation({ db, config, runDate, timezone, transporter });
}

export async function runCatalogReconciliation({ db, config, runDate, timezone = DEFAULT_TIMEZONE, transporter = null }) {
  const startedAt = new Date();
  const stats = {
    runDate,
    squareRecords: 0,
    changed: 0,
    insertedOrUpdated: 0,
    alreadyCurrent: 0,
    squareDeleted: 0,
    missingDeleted: 0,
    failed: 0,
    pages: 0,
    errors: [],
    samples: [],
  };
  const seenSquareTokens = new Set();

  await db.markReconciliationRun?.({
    runDate,
    status: "running",
    startedAt,
    summary: stats,
  });

  try {
    for await (const page of searchChangedCatalogObjectPages({ config, beginTime: null })) {
      stats.pages += 1;
      const variations = normalizeCatalogVariations(page);
      const activeVariationIds = variations.filter((variation) => !variation.deleted).map((variation) => variation.token);
      const quantities = await getSquareQuantitiesByCatalogObject({
        config,
        catalogObjectIds: activeVariationIds,
      });

      logger.info("Square catalog reconciliation page received", {
        runDate,
        page: stats.pages,
        objectCount: page.objects.length,
        variationCount: variations.length,
      });

      for (const variation of variations) {
        stats.squareRecords += 1;
        seenSquareTokens.add(variation.token);
        try {
          if (!variation.deleted) {
            await hydrateMissingCatalogFields({ config, variation });
            variation.quantity = quantities.get(variation.token) || 0;
          }
          const result = await db.upsertCatalogVariation(variation);
          if (result.changed) stats.changed += 1;
          if (variation.deleted && result.changed) stats.squareDeleted += 1;
          if (result.message?.includes("Already current")) stats.alreadyCurrent += 1;
          if (result.message?.includes("Inserted/updated") || result.message?.includes("Updated")) {
            stats.insertedOrUpdated += 1;
          }
          addSample(stats, {
            sku: variation.sku,
            token: variation.token,
            itemName: variation.itemName,
            variantName: variation.variationName,
            status: result.status,
            message: result.message,
          });
        } catch (error) {
          stats.failed += 1;
          addError(stats, `${variation.sku || variation.token}: ${error.message}`);
          logger.error("Square catalog reconciliation item failed", {
            runDate,
            token: variation.token,
            sku: variation.sku,
            error,
          });
        }
      }
    }

    const activeLocalRecords = await db.listActiveCatalogRecords?.() || [];
    for (const record of activeLocalRecords) {
      if (seenSquareTokens.has(record.Token)) continue;
      try {
        const result = await db.markMissingSquareCatalogDeleted(record, new Date());
        if (result.changed) {
          stats.changed += 1;
          stats.missingDeleted += 1;
          addSample(stats, {
            sku: record.SKU,
            token: record.Token,
            itemName: record.ItemName,
            variantName: record.VarName,
            status: "deleted",
            message: "Active local record was not found in Square full catalog",
          });
        }
      } catch (error) {
        stats.failed += 1;
        addError(stats, `${record.SKU || record.Token}: ${error.message}`);
        logger.error("Square catalog reconciliation missing-token delete failed", {
          runDate,
          token: record.Token,
          sku: record.SKU,
          error,
        });
      }
    }

    stats.finishedAt = new Date().toISOString();
    const status = stats.failed > 0 ? "failed" : "completed";
    await db.markReconciliationRun?.({
      runDate,
      status,
      startedAt,
      finishedAt: new Date(),
      summary: stats,
      lastError: stats.errors.join("\n"),
    });

    const emailResult = await sendReconciliationEmail({ config, runDate, timezone, stats, transporter });
    if (emailResult.sent && stats.failed === 0) {
      await db.markReconciliationRun?.({
        runDate,
        status: "sent",
        startedAt,
        finishedAt: new Date(),
        summary: stats,
      });
    } else if (!emailResult.sent && config.reconciliation?.emailEnabled) {
      await db.markReconciliationRun?.({
        runDate,
        status: "failed",
        startedAt,
        finishedAt: new Date(),
        summary: stats,
        lastError: `Reconciliation completed but email was not sent: ${emailResult.reason || "unknown"}`,
      });
    }

    logger.info("Square catalog reconciliation completed", {
      runDate,
      status,
      squareRecords: stats.squareRecords,
      changed: stats.changed,
      failed: stats.failed,
      email: emailResult.sent ? "sent" : emailResult.reason,
    });
    return { ran: true, status, stats, email: emailResult };
  } catch (error) {
    stats.failed += 1;
    addError(stats, error.message);
    await db.markReconciliationRun?.({
      runDate,
      status: "failed",
      startedAt,
      finishedAt: new Date(),
      summary: stats,
      lastError: String(error?.stack || error?.message || error).slice(0, 5000),
    });
    logger.error("Square catalog reconciliation failed", { runDate, error });
    await sendReconciliationEmail({ config, runDate, timezone, stats, transporter, error });
    return { ran: true, status: "failed", stats, error };
  }
}

async function hydrateMissingCatalogFields({ config, variation }) {
  if (!variation.category && variation.categoryId) {
    const category = await retrieveCatalogObject({ config, objectId: variation.categoryId });
    variation.category = category?.category_data?.name || variation.categoryId;
  }
}

async function sendReconciliationEmail({ config, runDate, timezone, stats, transporter = null, error = null }) {
  const emailConfig = config.summaryEmail || {};
  if (!config.reconciliation?.emailEnabled) return { sent: false, reason: "disabled" };

  const missing = missingEmailConfig(emailConfig);
  if (missing.length) {
    logger.warn("Square catalog reconciliation email skipped", { runDate, missing: missing.join(",") });
    return { sent: false, reason: "missing_config", missing };
  }

  const subjectStatus = error || stats.failed > 0 ? "FAILED" : "Complete";
  const text = buildReconciliationText({ runDate, timezone, stats, error });
  const html = buildReconciliationHtml({ runDate, timezone, stats, error });
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
      subject: `Square Catalog Reconciliation ${subjectStatus} - ${runDate}`,
      text,
      html,
    });
    return { sent: true };
  } catch (sendError) {
    logger.error("Square catalog reconciliation email failed", { runDate, error: sendError });
    return { sent: false, reason: "send_failed", error: sendError };
  }
}

export function buildReconciliationText({ runDate, timezone, stats, error = null }) {
  return [
    "Square Catalog Reconciliation",
    `Date: ${runDate} (${timezone})`,
    `Status: ${error || stats.failed > 0 ? "FAILED" : "Complete"}`,
    "",
    `Square records scanned: ${stats.squareRecords}`,
    `Pages scanned: ${stats.pages}`,
    `Database changes: ${stats.changed}`,
    `Inserted/updated: ${stats.insertedOrUpdated}`,
    `Already current: ${stats.alreadyCurrent}`,
    `Deleted from Square: ${stats.squareDeleted}`,
    `Missing locally marked deleted: ${stats.missingDeleted}`,
    `Failures: ${stats.failed}`,
    "",
    "Sample changes:",
    ...formatSamples(stats.samples),
    "",
    "Errors:",
    ...(stats.errors.length ? stats.errors.map((item) => `  ${item}`) : ["  none"]),
    "",
  ].join("\n");
}

export function buildReconciliationHtml({ runDate, timezone, stats, error = null }) {
  return `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; color: #222; line-height: 1.35;">
    <h2 style="margin: 0 0 8px;">Square Catalog Reconciliation</h2>
    <p style="margin: 0 0 12px;">
      <strong>Date:</strong> ${escapeHtml(runDate)} (${escapeHtml(timezone)})<br>
      <strong>Status:</strong> ${escapeHtml(error || stats.failed > 0 ? "FAILED" : "Complete")}
    </p>
    <table cellpadding="6" cellspacing="0" border="1" style="border-collapse: collapse; font-size: 13px;">
      <tbody>
        ${summaryRow("Square records scanned", stats.squareRecords)}
        ${summaryRow("Pages scanned", stats.pages)}
        ${summaryRow("Database changes", stats.changed)}
        ${summaryRow("Inserted/updated", stats.insertedOrUpdated)}
        ${summaryRow("Already current", stats.alreadyCurrent)}
        ${summaryRow("Deleted from Square", stats.squareDeleted)}
        ${summaryRow("Missing locally marked deleted", stats.missingDeleted)}
        ${summaryRow("Failures", stats.failed)}
      </tbody>
    </table>
    <h3 style="margin: 16px 0 8px;">Sample Changes</h3>
    ${htmlSamples(stats.samples)}
    <h3 style="margin: 16px 0 8px;">Errors</h3>
    ${stats.errors.length ? `<ul>${stats.errors.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "<p>none</p>"}
  </body>
</html>`;
}

function addSample(stats, sample) {
  if (!sample.sku && !sample.token) return;
  if (stats.samples.length < 50) stats.samples.push(sample);
}

function addError(stats, message) {
  if (stats.errors.length < 50) stats.errors.push(message);
}

function formatSamples(samples) {
  if (!samples?.length) return ["  none"];
  return samples.map((sample) =>
    `  ${sample.status}: ${sample.sku || ""} ${sample.itemName || ""} ${sample.variantName || ""} - ${sample.message || ""}`.trimEnd()
  );
}

function htmlSamples(samples) {
  if (!samples?.length) return "<p>none</p>";
  const rows = samples.map((sample) => `
    <tr>
      <td>${escapeHtml(sample.status || "")}</td>
      <td>${escapeHtml(sample.sku || "")}</td>
      <td>${escapeHtml(sample.itemName || "")}</td>
      <td>${escapeHtml(sample.variantName || "")}</td>
      <td>${escapeHtml(sample.message || "")}</td>
    </tr>`).join("");
  return `<table cellpadding="6" cellspacing="0" border="1" style="border-collapse: collapse; font-size: 13px;">
    <thead><tr><th>Status</th><th>SKU</th><th>Item</th><th>Variation</th><th>Message</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function summaryRow(label, value) {
  return `<tr><th align="left">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
}

function missingEmailConfig(emailConfig) {
  const missing = [];
  if (!emailConfig.from) missing.push("SUMMARY_EMAIL_FROM");
  if (!emailConfig.to) missing.push("SUMMARY_EMAIL_TO");
  if (!emailConfig.smtp?.host) missing.push("SMTP_HOST");
  if (emailConfig.smtp?.user && !emailConfig.smtp?.password) missing.push("SMTP_PASSWORD");
  return missing;
}

function isDue(localNow, time) {
  const [hour, minute] = String(time).split(":").map((value) => Number.parseInt(value, 10));
  return localNow.hour === hour && localNow.minute === minute;
}

function getZonedParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function formatDate(parts) {
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
