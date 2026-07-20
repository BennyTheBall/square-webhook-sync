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
    findSkuRecord: (squareToken) => findSkuRecord(pool, tables, squareToken),
    updateLocalQuantity: ({ skuRecord, quantity }) => updateLocalQuantity(pool, tables, skuRecord, quantity, new Date()),
    updateShopifyId: ({ skuRecord, shopifyId }) => updateShopifyId(pool, tables, skuRecord, shopifyId, new Date()),
    getShopifyToken: (storeKey) => getShopifyToken(pool, storeKey),
    saveShopifyToken: (token) => saveShopifyToken(pool, token),
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
      WHERE status IN ('received','failed')
      ORDER BY received_at ASC
      LIMIT ${safeLimit}`
  );
  return rows.map((row) => ({
    eventId: row.event_id,
    payload: typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : row.payload_json
  }));
}

export async function findSkuRecord(db, tables, squareToken) {
  const [rows] = await db.execute(
    `SELECT ID, Token, SKU, ItemName, VarName, Quantity, ShopifyID, AmazonSKU, Vendor
       FROM ${escapeId(tables.sku)}
      WHERE Token = :squareToken AND Deleted IS NULL
      LIMIT 1`,
    { squareToken }
  );
  return rows[0] || null;
}

export async function updateLocalQuantity(db, tables, skuRecord, quantity, changedAt) {
  if (Number(skuRecord.Quantity) === Number(quantity)) return { changed: false };

  await db.execute(
    `UPDATE ${escapeId(tables.sku)}
        SET Quantity = :quantity
      WHERE ID = :id`,
    { quantity, id: skuRecord.ID }
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

export function escapeId(identifier) {
  if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `\`${identifier}\``;
}
