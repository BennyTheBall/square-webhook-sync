import mysql from "mysql2/promise";

export function createDb(config) {
  const pool = mysql.createPool({
    ...config.mysql,
    waitForConnections: true,
    connectionLimit: 6,
    namedPlaceholders: true,
    timezone: "Z"
  });

  const tables = config.tables;
  return {
    pool,
    close: () => pool.end(),
    claimEvent: async ({ eventId, payload }) => {
      const result = await claimEvent(pool, tables, { ...payload, event_id: eventId });
      return result.inserted;
    },
    markEventProcessing: (eventId) => markEventProcessing(pool, tables, eventId),
    markEventProcessed: (eventId) => markEventProcessed(pool, tables, eventId),
    markEventFailed: (eventId, error) => markEventFailed(pool, tables, eventId, error),
    listPendingEvents: async ({ limit } = {}) => {
      const rows = await listPendingEvents(pool, tables, limit);
      return rows.map((row) => ({
        event_id: row.eventId,
        payload_json: row.payload
      }));
    },
    listFailedSyncResults: ({ limit } = {}) => listFailedSyncResults(pool, limit),
    updateSyncResult: (result) => updateSyncResult(pool, result),
    hasFailedSyncResults: (eventId) => hasFailedSyncResults(pool, eventId),
    findSkuRecord: (squareToken) => findSkuRecord(pool, tables, squareToken),
    updateLocalQuantity: ({ skuRecord, quantity }) => updateLocalQuantity(pool, tables, skuRecord, quantity, new Date()),
    getCatalogSyncState: () => getCatalogSyncState(pool, tables),
    markCatalogSyncState: (state) => markCatalogSyncState(pool, tables, state),
    upsertCatalogVariation: (variation) => upsertCatalogVariation(pool, tables, variation, new Date()),
    getReconciliationRun: (runDate) => getReconciliationRun(pool, runDate),
    markReconciliationRun: (run) => markReconciliationRun(pool, run),
    resetCatalogReconciliationStage: (runDate) => resetCatalogReconciliationStage(pool, runDate),
    stageCatalogVariations: (runDate, variations) => stageCatalogVariations(pool, runDate, variations),
    listCatalogReconciliationStage: (runDate) => listCatalogReconciliationStage(pool, runDate),
    listActiveCatalogRecordsMissingFromStage: (runDate) => listActiveCatalogRecordsMissingFromStage(pool, tables, runDate),
    listActiveCatalogRecords: () => listActiveCatalogRecords(pool, tables),
    markMissingSquareCatalogDeleted: (record, changedAt) => markMissingSquareCatalogDeleted(pool, tables, record, changedAt),
    updateShopifyId: ({ skuRecord, shopifyId }) => updateShopifyId(pool, tables, skuRecord, shopifyId, new Date()),
    getShopifyToken: (storeKey) => getShopifyToken(pool, storeKey),
    saveShopifyToken: (token) => saveShopifyToken(pool, token),
    getDailySummaryEmail: (summaryDate) => getDailySummaryEmail(pool, summaryDate),
    markDailySummaryEmail: (result) => markDailySummaryEmail(pool, result),
    getDailySummary: (range) => getDailySummary(pool, range),
    recordSyncResult: (result) =>
      recordSyncResult(
        pool,
        result.eventId,
        result.sku,
        result.catalogObjectId,
        result.itemName,
        result.variantName,
        result.vendor,
        result.quantity,
        result.marketplace,
        result.externalId || result.target || null,
        result.status,
        result.message || (result.quantity == null ? "" : `Quantity ${result.quantity}`)
      )
  };
}

export async function claimEvent(db, tables, event) {
  const sql = `
    INSERT INTO ${escapeId(tables.webhook)}
      (event_id, event_type, merchant_id, square_created_at, status, payload_json)
    VALUES
      (:eventId, :eventType, :merchantId, :squareCreatedAt, 'received', CAST(:payloadJson AS JSON))
  `;

  try {
    await db.execute(sql, {
      eventId: event.event_id,
      eventType: event.type || null,
      merchantId: event.merchant_id || null,
      squareCreatedAt: event.created_at ? new Date(event.created_at) : null,
      payloadJson: JSON.stringify(event)
    });
    return { inserted: true };
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") return { inserted: false, duplicate: true };
    throw error;
  }
}

export async function markEventProcessing(db, tables, eventId) {
  await db.execute(
    `UPDATE ${escapeId(tables.webhook)}
       SET status = 'processing', attempt_count = attempt_count + 1, last_error = NULL
     WHERE event_id = :eventId`,
    { eventId }
  );
}

export async function markEventProcessed(db, tables, eventId) {
  await db.execute(
    `UPDATE ${escapeId(tables.webhook)}
       SET status = 'processed', processed_at = NOW(), last_error = NULL
     WHERE event_id = :eventId`,
    { eventId }
  );
}

export async function markEventFailed(db, tables, eventId, error) {
  await db.execute(
    `UPDATE ${escapeId(tables.webhook)}
       SET status = 'failed', last_error = :lastError
     WHERE event_id = :eventId`,
    { eventId, lastError: String(error?.stack || error?.message || error).slice(0, 5000) }
  );
}

export async function listPendingEvents(db, tables, limit = 25) {
  const safeLimit = Math.max(1, Math.min(500, Number.parseInt(limit, 10) || 25));
  const [rows] = await db.execute(
    `SELECT event_id, payload_json
       FROM ${escapeId(tables.webhook)}
      WHERE status = 'received'
         OR (
              status = 'failed'
              AND NOT EXISTS (
                SELECT 1
                  FROM square_inventory_sync_results
                 WHERE square_inventory_sync_results.event_id = ${escapeId(tables.webhook)}.event_id
                 LIMIT 1
              )
            )
      ORDER BY received_at ASC
      LIMIT ${safeLimit}`
  );
  return rows.map((row) => ({
    eventId: row.event_id,
    payload: typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : row.payload_json
  }));
}

export async function listFailedSyncResults(db, limit = 25) {
  const safeLimit = Math.max(1, Math.min(500, Number.parseInt(limit, 10) || 25));
  const [rows] = await db.execute(
    `SELECT id, event_id, sku, square_catalog_object_id, item_name, variant_name,
            vendor, quantity, marketplace, target, status, message, created_at
      FROM square_inventory_sync_results
      WHERE status = 'failed'
        AND marketplace <> 'local-catalog'
      ORDER BY created_at ASC, id ASC
      LIMIT ${safeLimit}`
  );
  return rows;
}

export async function updateSyncResult(db, result) {
  await db.execute(
    `UPDATE square_inventory_sync_results
        SET status = :status,
            target = :target,
            quantity = :quantity,
            message = :message
      WHERE id = :id
      LIMIT 1`,
    {
      id: result.id,
      status: result.status,
      target: result.target || null,
      quantity: result.quantity ?? null,
      message: String(result.message || "").slice(0, 5000)
    }
  );
}

export async function hasFailedSyncResults(db, eventId) {
  const [rows] = await db.execute(
    `SELECT 1
       FROM square_inventory_sync_results
      WHERE event_id = :eventId AND status = 'failed'
      LIMIT 1`,
    { eventId }
  );
  return rows.length > 0;
}

export async function findSkuRecord(db, tables, squareToken) {
  const [rows] = await db.execute(
    `SELECT ID, Token, SKU, ItemName, VarName, Quantity, ShopifyID, AmazonSKU, Vendor
       FROM ${escapeId(tables.skuTemp || tables.sku)}
      WHERE Token = :squareToken AND Deleted IS NULL
      LIMIT 1`,
    { squareToken }
  );
  return rows[0] || null;
}

export async function updateLocalQuantity(db, tables, skuRecord, quantity, changedAt) {
  if (Number(skuRecord.Quantity) === Number(quantity)) return { changed: false };

  await db.execute(
    `UPDATE ${escapeId(tables.skuTemp || tables.sku)}
        SET Quantity = :quantity
      WHERE ID = :id`,
    { quantity, id: skuRecord.ID }
  );

  await db.execute(
    `UPDATE ${escapeId(tables.skuMain || "SKU")}
        SET Quantity = :quantity
      WHERE Token = :token OR SKU = :sku`,
    { quantity, token: skuRecord.Token, sku: skuRecord.SKU }
  );

  await db.execute(
    `INSERT INTO ${escapeId(tables.skuHistory)}
       SET SKU = :sku, FieldName = 'Quantity', OldValue = :oldValue, NewValue = :newValue, Changed = :changed`,
    {
      sku: skuRecord.SKU,
      oldValue: String(skuRecord.Quantity),
      newValue: String(quantity),
      changed: changedAt
    }
  );

  return { changed: true };
}

export async function getCatalogSyncState(db, tables) {
  const [rows] = await db.execute(
    `SELECT latest_time, latest_square_time, last_event_id
       FROM ${escapeId(tables.catalogState)}
      WHERE state_key = 'catalog'
      LIMIT 1`
  );
  return rows[0] || null;
}

export async function markCatalogSyncState(db, tables, state) {
  await db.execute(
    `INSERT INTO ${escapeId(tables.catalogState)}
       (state_key, latest_time, latest_square_time, last_event_id)
     VALUES
       ('catalog', :latestTime, :latestSquareTime, :lastEventId)
     ON DUPLICATE KEY UPDATE
       latest_time = VALUES(latest_time),
       latest_square_time = VALUES(latest_square_time),
       last_event_id = VALUES(last_event_id)`,
    {
      latestTime: state.latestTime ? new Date(state.latestTime) : null,
      latestSquareTime: state.latestSquareTime || state.latestTime || null,
      lastEventId: state.lastEventId || null
    }
  );
}

export async function getReconciliationRun(db, runDate) {
  const [rows] = await db.execute(
    `SELECT run_date, status, started_at, finished_at, summary_json, last_error
       FROM square_catalog_reconciliation_runs
      WHERE run_date = :runDate
      LIMIT 1`,
    { runDate }
  );
  return rows[0] || null;
}

export async function markReconciliationRun(db, run) {
  await db.execute(
    `INSERT INTO square_catalog_reconciliation_runs
       (run_date, status, started_at, finished_at, summary_json, last_error)
     VALUES
       (:runDate, :status, :startedAt, :finishedAt, :summaryJson, :lastError)
     ON DUPLICATE KEY UPDATE
       status = VALUES(status),
       started_at = COALESCE(VALUES(started_at), started_at),
       finished_at = VALUES(finished_at),
       summary_json = VALUES(summary_json),
       last_error = VALUES(last_error)`,
    {
      runDate: run.runDate,
      status: run.status,
      startedAt: run.startedAt || null,
      finishedAt: run.finishedAt || null,
      summaryJson: JSON.stringify(run.summary || {}),
      lastError: run.lastError ? String(run.lastError).slice(0, 5000) : null
    }
  );
}

export async function resetCatalogReconciliationStage(db, runDate) {
  await db.execute(
    `DELETE FROM square_catalog_reconciliation_stage
      WHERE run_date = :runDate`,
    { runDate }
  );
}

export async function stageCatalogVariations(db, runDate, variations) {
  const rows = variations || [];
  if (!rows.length) return { inserted: 0 };

  let inserted = 0;
  for (const batch of chunks(rows, 100)) {
    const params = {};
    const valuesSql = batch.map((variation, index) => {
      const prefix = `r${index}`;
      params[`${prefix}RunDate`] = runDate;
      params[`${prefix}Token`] = clampText(variation.token, 128);
      params[`${prefix}Deleted`] = variation.deleted ? 1 : 0;
      params[`${prefix}SquareUpdatedAt`] = clampText(variation.updatedAt, 64) || null;
      params[`${prefix}ItemName`] = clampText(variation.itemName, 255);
      params[`${prefix}Description`] = variation.description || "";
      params[`${prefix}Category`] = clampText(variation.category, 128);
      params[`${prefix}CategoryId`] = clampText(variation.categoryId, 128);
      params[`${prefix}Sku`] = clampText(variation.sku, 128);
      params[`${prefix}Gtin`] = clampText(variation.gtin, 128);
      params[`${prefix}VariationName`] = clampText(variation.variationName, 255);
      params[`${prefix}Price`] = variation.price ?? null;
      params[`${prefix}Cost`] = variation.cost ?? null;
      params[`${prefix}Vendor`] = clampText(variation.vendor, 128);
      params[`${prefix}Quantity`] = variation.quantity ?? 0;
      params[`${prefix}AlertEnabled`] = clampText(variation.alertEnabled || "N", 8);
      params[`${prefix}AlertCount`] = variation.alertCount ?? null;
      params[`${prefix}Tax`] = clampText(variation.tax, 8);
      params[`${prefix}RawJson`] = JSON.stringify(variation.raw || {});
      return `(
        :${prefix}RunDate, :${prefix}Token, :${prefix}Deleted, :${prefix}SquareUpdatedAt,
        :${prefix}ItemName, :${prefix}Description, :${prefix}Category, :${prefix}CategoryId,
        :${prefix}Sku, :${prefix}Gtin, :${prefix}VariationName, :${prefix}Price,
        :${prefix}Cost, :${prefix}Vendor, :${prefix}Quantity, :${prefix}AlertEnabled,
        :${prefix}AlertCount, :${prefix}Tax, CAST(:${prefix}RawJson AS JSON)
      )`;
    }).join(", ");

    await db.execute(
      `INSERT INTO square_catalog_reconciliation_stage
         (run_date, token, deleted, square_updated_at, item_name, description, category, category_id,
          sku, gtin, variation_name, price, cost, vendor, quantity, alert_enabled, alert_count, tax, raw_json)
       VALUES ${valuesSql}
       ON DUPLICATE KEY UPDATE
         deleted = VALUES(deleted),
         square_updated_at = VALUES(square_updated_at),
         item_name = VALUES(item_name),
         description = VALUES(description),
         category = VALUES(category),
         category_id = VALUES(category_id),
         sku = VALUES(sku),
         gtin = VALUES(gtin),
         variation_name = VALUES(variation_name),
         price = VALUES(price),
         cost = VALUES(cost),
         vendor = VALUES(vendor),
         quantity = VALUES(quantity),
         alert_enabled = VALUES(alert_enabled),
         alert_count = VALUES(alert_count),
         tax = VALUES(tax),
         raw_json = VALUES(raw_json)`,
      params
    );
    inserted += batch.length;
  }

  return { inserted };
}

export async function listCatalogReconciliationStage(db, runDate) {
  const [rows] = await db.execute(
    `SELECT token, deleted, square_updated_at, item_name, description, category, category_id,
            sku, gtin, variation_name, price, cost, vendor, quantity, alert_enabled,
            alert_count, tax, raw_json
       FROM square_catalog_reconciliation_stage
      WHERE run_date = :runDate
      ORDER BY token`,
    { runDate }
  );
  return rows.map((row) => ({
    token: row.token,
    deleted: Boolean(row.deleted),
    updatedAt: row.square_updated_at,
    itemName: emptyStringToNull(row.item_name),
    description: emptyStringToNull(row.description),
    category: emptyStringToNull(row.category),
    categoryId: emptyStringToNull(row.category_id),
    sku: emptyStringToNull(row.sku),
    gtin: emptyStringToNull(row.gtin),
    variationName: emptyStringToNull(row.variation_name),
    price: row.price == null ? null : String(row.price),
    cost: row.cost == null ? null : String(row.cost),
    vendor: emptyStringToNull(row.vendor),
    quantity: row.quantity == null ? 0 : Number(row.quantity),
    alertEnabled: row.alert_enabled || "N",
    alertCount: row.alert_count,
    tax: emptyStringToNull(row.tax),
    raw: parseJson(row.raw_json) || {},
  }));
}

export async function listActiveCatalogRecordsMissingFromStage(db, tables, runDate) {
  const [rows] = await db.execute(
    `SELECT l.ID, l.Token, l.SKU, l.ItemName, l.VarName, l.Deleted
       FROM ${escapeId(tables.skuTemp || tables.sku)} l
       LEFT JOIN square_catalog_reconciliation_stage staged
         ON staged.run_date = :runDate
        AND staged.token = l.Token
      WHERE l.Deleted IS NULL
        AND l.Token IS NOT NULL
        AND l.Token <> ''
        AND staged.token IS NULL`,
    { runDate }
  );
  return rows;
}

export async function listActiveCatalogRecords(db, tables) {
  const [rows] = await db.execute(
    `SELECT ID, Token, SKU, ItemName, VarName, Deleted
       FROM ${escapeId(tables.skuTemp || tables.sku)}
      WHERE Deleted IS NULL
        AND Token IS NOT NULL
        AND Token <> ''`
  );
  return rows;
}

export async function upsertCatalogVariation(db, tables, variation, changedAt) {
  if (!variation.token) {
    return { status: "skipped", changed: false, message: "Missing Square variation token" };
  }

  const existingTemp = await findCatalogRecord(db, tables.skuTemp || tables.sku, variation);
  const existingMain = await findCatalogRecord(db, tables.skuMain || "SKU", variation);

  if (variation.deleted) {
    const tempResult = await markCatalogDeleted(db, tables, tables.skuTemp || tables.sku, existingTemp, variation, changedAt);
    const mainResult = await markCatalogDeleted(db, tables, tables.skuMain || "SKU", existingMain, variation, changedAt);
    return {
      status: tempResult.changed || mainResult.changed ? "success" : "skipped",
      changed: tempResult.changed || mainResult.changed,
      message: tempResult.changed || mainResult.changed ? "Marked deleted" : "Already deleted or not found"
    };
  }

  const requiredMissing = [];
  if (!variation.sku) requiredMissing.push("SKU");
  if (!variation.itemName) requiredMissing.push("ItemName");
  if (!variation.category) requiredMissing.push("Cat");
  if (variation.price == null) requiredMissing.push("Price");
  if (variation.cost == null) requiredMissing.push("Cost");
  if (requiredMissing.length) {
    return {
      status: "failed",
      changed: false,
      message: `Missing required Square catalog fields: ${requiredMissing.join(", ")}`
    };
  }

  const tempResult = await upsertCatalogTable(db, tables, tables.skuTemp || tables.sku, "temp", existingTemp, variation, changedAt);
  const mainResult = await upsertCatalogTable(db, tables, tables.skuMain || "SKU", "main", existingMain, variation, changedAt);

  return {
    status: "success",
    changed: tempResult.changed || mainResult.changed,
    message: tempResult.inserted || mainResult.inserted
      ? "Inserted/updated from Square catalog"
      : (tempResult.changed || mainResult.changed ? "Updated from Square catalog" : "Already current")
  };
}

async function findCatalogRecord(db, table, variation) {
  const [rows] = await db.execute(
    `SELECT *
       FROM ${escapeId(table)}
      WHERE (:sku <> '' AND SKU = :sku) OR Token = :token
      ORDER BY CASE
          WHEN :sku <> '' AND SKU = :sku THEN 0
          WHEN Token = :token THEN 1
          ELSE 2
        END,
        ID DESC
      LIMIT 1`,
    { token: variation.token, sku: variation.sku || "" }
  );
  return rows[0] || null;
}

async function markCatalogDeleted(db, tables, table, existing, variation, changedAt) {
  if (!existing) return { changed: false };

  const deletedValue = table === (tables.skuTemp || tables.sku) ? existing.ID : "Y";
  const isDeleted = table === (tables.skuTemp || tables.sku)
    ? existing.Deleted != null
    : String(existing.Deleted || "N").toUpperCase() === "Y";

  if (isDeleted) return { changed: false };

  await db.execute(
    `UPDATE ${escapeId(table)}
        SET Deleted = :deleted, Remove = 'Y'
      WHERE ID = :id
      LIMIT 1`,
    { deleted: deletedValue, id: existing.ID }
  );
  if (table === (tables.skuTemp || tables.sku)) {
    await insertHistory(db, tables, existing.SKU || variation.sku || variation.token, "DELETED", existing.Deleted ?? "", String(deletedValue), changedAt);
  }
  return { changed: true };
}

export async function markMissingSquareCatalogDeleted(db, tables, record, changedAt) {
  const tempRecord = await findCatalogRecord(db, tables.skuTemp || tables.sku, {
    token: record.Token,
    sku: record.SKU
  });
  const mainRecord = await findCatalogRecord(db, tables.skuMain || "SKU", {
    token: record.Token,
    sku: record.SKU
  });
  const variation = {
    token: record.Token,
    sku: record.SKU,
    deleted: true
  };
  const tempResult = await markCatalogDeleted(db, tables, tables.skuTemp || tables.sku, tempRecord, variation, changedAt);
  const mainResult = await markCatalogDeleted(db, tables, tables.skuMain || "SKU", mainRecord, variation, changedAt);
  return {
    changed: tempResult.changed || mainResult.changed
  };
}

async function upsertCatalogTable(db, tables, table, kind, existing, variation, changedAt) {
  const deletedValue = kind === "temp" ? null : "N";
  const variantParts = parseVariationParts(variation.variationName);
  const values = {
    Token: variation.token,
    ItemName: variation.itemName,
    Description: variation.description || "",
    Cat: variation.category,
    SKU: variation.sku,
    GTIN: variation.gtin || "",
    VarName: variation.variationName || "",
    Price: variation.price,
    Cost: variation.cost,
    Vendor: variation.vendor || "",
    Quantity: variation.quantity ?? existing?.Quantity ?? 0,
    AlertEnable: variation.alertEnabled || "N",
    AlertCount: variation.alertCount ?? null,
    Tax: variation.tax || existing?.Tax || "Y",
    Remove: "N",
    Deleted: deletedValue
  };
  if (kind === "temp") {
    values.Size = variantParts.size;
    values.Color = variantParts.color;
    values.Style = variantParts.style;
  }

  if (!existing) {
    const columns = Object.keys(values);
    await db.execute(
      `INSERT INTO ${escapeId(table)}
         (${columns.map(escapeId).join(", ")})
       VALUES
         (${columns.map((column) => `:${column}`).join(", ")})`,
      values
    );
    if (kind === "temp") {
      await insertHistory(db, tables, values.SKU, "INSERT", "", "Inserted from Square catalog", changedAt);
      await insertCatalogFieldHistory(db, tables, values.SKU, Object.entries(values), {}, changedAt);
    }
    return { inserted: true, changed: true };
  }

  const changedFields = Object.entries(values)
    .filter(([field, value]) => !catalogValuesEqual(existing[field], value));
  if (!changedFields.length) return { inserted: false, changed: false };

  if (kind === "main" && changedFields.some(([field]) => field === "Token")) {
    await clearStaleTokenConflict(db, tables, table, existing, values.Token, changedAt);
  }

  await db.execute(
    `UPDATE ${escapeId(table)}
        SET ${changedFields.map(([field]) => `${escapeId(field)} = :${field}`).join(", ")}
      WHERE ID = :ID
      LIMIT 1`,
    { ...Object.fromEntries(changedFields), ID: existing.ID }
  );

  const historySku = values.SKU || existing.SKU || variation.token;
  if (kind === "temp") {
    await insertCatalogFieldHistory(db, tables, historySku, changedFields, existing, changedAt);
  }
  return { inserted: false, changed: true };
}

async function clearStaleTokenConflict(db, tables, table, existing, token, changedAt) {
  const [rows] = await db.execute(
    `SELECT ID, SKU, Token, Deleted
       FROM ${escapeId(table)}
      WHERE Token = :token
        AND ID <> :id
      LIMIT 1`,
    { token, id: existing.ID }
  );
  const conflict = rows[0];
  if (!conflict) return;

  if (String(conflict.Deleted || "N").toUpperCase() !== "Y") {
    throw new Error(`Square token ${token} is already assigned to active SKU ${conflict.SKU || conflict.ID}`);
  }

  const staleToken = `STALE-${conflict.ID}`;
  await db.execute(
    `UPDATE ${escapeId(table)}
        SET Token = :staleToken
      WHERE ID = :id
      LIMIT 1`,
    { staleToken, id: conflict.ID }
  );
  await insertHistory(db, tables, conflict.SKU || conflict.ID, "Token", conflict.Token, staleToken, changedAt);
}

async function insertCatalogFieldHistory(db, tables, sku, fields, existing, changedAt) {
  for (const [field, value] of fields) {
    if (field === "Remove" || field === "Deleted") continue;
    await insertHistory(db, tables, sku, field, existing[field] ?? "", value ?? "", changedAt);
  }
}

async function insertHistory(db, tables, sku, fieldName, oldValue, newValue, changedAt) {
  await db.execute(
    `INSERT INTO ${escapeId(tables.skuHistory)}
       SET SKU = :sku, FieldName = :fieldName, OldValue = :oldValue, NewValue = :newValue, Changed = :changed`,
    {
      sku: String(sku || "").slice(0, 20),
      fieldName: String(fieldName || "").slice(0, 20),
      oldValue: stringifyHistoryValue(oldValue),
      newValue: stringifyHistoryValue(newValue),
      changed: changedAt
    }
  );
}

function stringifyHistoryValue(value) {
  if (value == null) return "";
  return String(value).slice(0, 255);
}

function catalogValuesEqual(left, right) {
  if (left == null && right == null) return true;
  if (left == null || right == null) return false;
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return Math.abs(leftNumber - rightNumber) < 0.0001;
  }
  return String(left).trim() === String(right).trim();
}

function parseVariationParts(variationName) {
  const normalizedName = String(variationName || "").trim();
  if (!normalizedName.includes(",")) {
    return {
      size: "",
      color: "",
      style: clampCatalogDetail(normalizedName, 50),
    };
  }

  const parts = normalizedName
    .split(",")
    .map((part) => part.trim());

  return {
    size: clampCatalogDetail(parts[0], 20),
    color: clampCatalogDetail(parts[1], 50),
    style: clampCatalogDetail(parts.slice(2).join(","), 50),
  };
}

function clampCatalogDetail(value, maxLength) {
  return String(value || "").slice(0, maxLength);
}

function clampText(value, maxLength) {
  return String(value || "").slice(0, maxLength);
}

function chunks(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

function emptyStringToNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

function parseJson(value) {
  if (value == null || value === "") return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function updateShopifyId(db, tables, skuRecord, inventoryItemId, changedAt) {
  if (skuRecord.ShopifyID === inventoryItemId) return { changed: false };

  await db.execute(
    `UPDATE ${escapeId(tables.sku)}
        SET ShopifyID = :inventoryItemId
      WHERE ID = :id
      LIMIT 1`,
    { inventoryItemId, id: skuRecord.ID }
  );

  await db.execute(
    `INSERT INTO ${escapeId(tables.skuHistory)}
       SET SKU = :sku, FieldName = 'ShopifyID', OldValue = :oldValue, NewValue = :newValue, Changed = :changed`,
    {
      sku: skuRecord.SKU,
      oldValue: skuRecord.ShopifyID || "",
      newValue: inventoryItemId,
      changed: changedAt
    }
  );

  return { changed: true };
}

export async function recordSyncResult(
  db,
  eventId,
  sku,
  squareCatalogObjectId,
  itemName,
  variantName,
  vendor,
  quantity,
  marketplace,
  target,
  status,
  message
) {
  await db.execute(
    `INSERT INTO square_inventory_sync_results
       (event_id, sku, square_catalog_object_id, item_name, variant_name, vendor, quantity, marketplace, target, status, message)
     VALUES
       (:eventId, :sku, :squareCatalogObjectId, :itemName, :variantName, :vendor, :quantity, :marketplace, :target, :status, :message)`,
    {
      eventId,
      sku,
      squareCatalogObjectId,
      itemName: itemName || null,
      variantName: variantName || null,
      vendor: vendor || null,
      quantity: quantity ?? null,
      marketplace,
      target,
      status,
      message: String(message || "").slice(0, 5000)
    }
  );
}

export async function getShopifyToken(db, storeKey) {
  const [rows] = await db.execute(
    `SELECT store_key, shop_domain, access_method, access_token, access_token_expires_at,
            refresh_token, refresh_token_expires_at, scope
       FROM shopify_store_tokens
      WHERE store_key = :storeKey
      LIMIT 1`,
    { storeKey }
  );
  return rows[0] || null;
}

export async function saveShopifyToken(db, token) {
  await db.execute(
    `INSERT INTO shopify_store_tokens
       (store_key, shop_domain, access_method, access_token, access_token_expires_at,
        refresh_token, refresh_token_expires_at, scope)
     VALUES
       (:storeKey, :shopDomain, :accessMethod, :accessToken, :accessTokenExpiresAt,
        :refreshToken, :refreshTokenExpiresAt, :scope)
     ON DUPLICATE KEY UPDATE
       shop_domain = VALUES(shop_domain),
       access_method = VALUES(access_method),
       access_token = VALUES(access_token),
       access_token_expires_at = VALUES(access_token_expires_at),
       refresh_token = VALUES(refresh_token),
       refresh_token_expires_at = VALUES(refresh_token_expires_at),
       scope = VALUES(scope)`,
    {
      storeKey: token.storeKey,
      shopDomain: token.shopDomain,
      accessMethod: token.accessMethod,
      accessToken: token.accessToken,
      accessTokenExpiresAt: token.accessTokenExpiresAt || null,
      refreshToken: token.refreshToken || null,
      refreshTokenExpiresAt: token.refreshTokenExpiresAt || null,
      scope: token.scope || null
    }
  );
}

export async function getDailySummaryEmail(db, summaryDate) {
  const [rows] = await db.execute(
    `SELECT summary_date, recipient, status, sent_at, last_error
       FROM daily_summary_emails
      WHERE summary_date = :summaryDate
      LIMIT 1`,
    { summaryDate }
  );
  return rows[0] || null;
}

export async function markDailySummaryEmail(db, result) {
  await db.execute(
    `INSERT INTO daily_summary_emails
       (summary_date, recipient, status, sent_at, last_error)
     VALUES
       (:summaryDate, :recipient, :status, :sentAt, :lastError)
     ON DUPLICATE KEY UPDATE
       recipient = VALUES(recipient),
       status = VALUES(status),
       sent_at = VALUES(sent_at),
       last_error = VALUES(last_error)`,
    {
      summaryDate: result.summaryDate,
      recipient: result.recipient,
      status: result.status,
      sentAt: result.sentAt || null,
      lastError: result.lastError || null
    }
  );
}

export async function getDailySummary(db, { startUtc, endUtc }) {
  const params = { startUtc, endUtc };
  const [events] = await db.execute(
    `SELECT status, COUNT(*) AS count
       FROM square_webhook_events
      WHERE received_at >= :startUtc AND received_at < :endUtc
      GROUP BY status
      ORDER BY status`,
    params
  );
  const [results] = await db.execute(
    `SELECT marketplace, status, COUNT(*) AS count
       FROM square_inventory_sync_results
      WHERE created_at >= :startUtc AND created_at < :endUtc
      GROUP BY marketplace, status
      ORDER BY marketplace, status`,
    params
  );
  const [products] = await db.execute(
    `SELECT COUNT(DISTINCT sku) AS sku_count,
            COUNT(DISTINCT event_id) AS event_count,
            COUNT(*) AS result_count
       FROM square_inventory_sync_results
      WHERE created_at >= :startUtc AND created_at < :endUtc`,
    params
  );
  const [failures] = await db.execute(
    `SELECT event_id, sku, item_name, variant_name, vendor, quantity,
            marketplace, status, message, created_at
       FROM square_inventory_sync_results
      WHERE created_at >= :startUtc AND created_at < :endUtc
        AND status = 'failed'
      ORDER BY created_at DESC
      LIMIT 25`,
    params
  );
  const [recent] = await db.execute(
    `SELECT event_id, sku, item_name, variant_name, vendor, quantity,
            marketplace, status, message, created_at
       FROM square_inventory_sync_results
      WHERE created_at >= :startUtc AND created_at < :endUtc
      ORDER BY created_at DESC
      LIMIT 25`,
    params
  );
  const [activity] = await db.execute(
    `SELECT event_id, sku, item_name, variant_name, vendor, quantity,
            marketplace, status, message, created_at
       FROM square_inventory_sync_results
      WHERE created_at >= :startUtc AND created_at < :endUtc
      ORDER BY created_at DESC
      LIMIT 1000`,
    params
  );

  return {
    events,
    results,
    products: products[0] || { sku_count: 0, event_count: 0, result_count: 0 },
    failures,
    recent,
    activity
  };
}

export function escapeId(identifier) {
  if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `\`${identifier}\``;
}
