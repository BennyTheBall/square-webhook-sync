import { extractInventoryCounts } from './square.js';
import { syncShopifyStore } from './marketplaces/shopify.js';
import { syncWalmart } from './marketplaces/walmart.js';
import { syncAmazon } from './marketplaces/amazon.js';
import { logger } from './logger.js';

function getSkuCode(skuRecord) {
  return skuRecord.SKU || skuRecord.Sku || skuRecord.Code || skuRecord.Barcode || skuRecord.Token;
}

function getCurrentQuantity(skuRecord) {
  return Number.parseInt(skuRecord.Quantity ?? skuRecord.quantity ?? '0', 10) || 0;
}

async function recordResult(db, result) {
  if (typeof db.recordSyncResult === 'function') {
    await db.recordSyncResult(result);
  }
}

export async function processSquareEvent({ db, config, eventId, payload }) {
  await db.markEventProcessing(eventId);

  const counts = extractInventoryCounts(payload);
  const failures = [];
  let processedCount = 0;

  for (const count of counts) {
    const skuRecord = await db.findSkuRecord(count.catalogObjectId);
    if (!skuRecord) {
      await recordResult(db, {
        eventId,
        catalogObjectId: count.catalogObjectId,
        sku: null,
        marketplace: 'local',
        status: 'skipped',
        message: 'No SKU_Temp record found for Square catalog object',
      });
      continue;
    }

    const sku = getSkuCode(skuRecord);
    const oldQuantity = getCurrentQuantity(skuRecord);

    if (oldQuantity !== count.quantity) {
      await db.updateLocalQuantity({
        skuRecord,
        quantity: count.quantity,
        oldQuantity,
        source: 'Square webhook',
      });
    }

    await recordResult(db, {
      eventId,
      catalogObjectId: count.catalogObjectId,
      sku,
      marketplace: 'local',
      status: 'success',
      quantity: count.quantity,
      message: oldQuantity === count.quantity ? 'Already current' : `Updated from ${oldQuantity} to ${count.quantity}`,
    });

    for (const store of config.shopify.stores) {
      try {
        const result = await syncShopifyStore({ store, db, skuRecord, quantity: count.quantity, eventId });
        if (result.externalId && store.useLegacyShopifyIdColumn && !skuRecord.ShopifyID && typeof db.updateShopifyId === 'function') {
          await db.updateShopifyId({ skuRecord, shopifyId: result.externalId });
        }
        await recordResult(db, {
          eventId,
          catalogObjectId: count.catalogObjectId,
          sku,
          marketplace: `shopify:${store.key}`,
          status: result.status,
          quantity: count.quantity,
          externalId: result.externalId,
          message: result.message,
        });
      } catch (error) {
        failures.push(error);
        await recordResult(db, {
          eventId,
          catalogObjectId: count.catalogObjectId,
          sku,
          marketplace: `shopify:${store.key}`,
          status: 'failed',
          quantity: count.quantity,
          message: error.message,
        });
      }
    }

    try {
      const result = await syncWalmart({ config: config.walmart, skuRecord, quantity: count.quantity });
      await recordResult(db, {
        eventId,
        catalogObjectId: count.catalogObjectId,
        sku,
        marketplace: 'walmart',
        status: result.status,
        quantity: count.quantity,
        externalId: result.externalId,
        message: result.message,
      });
    } catch (error) {
      failures.push(error);
      await recordResult(db, {
        eventId,
        catalogObjectId: count.catalogObjectId,
        sku,
        marketplace: 'walmart',
        status: 'failed',
        quantity: count.quantity,
        message: error.message,
      });
    }

    try {
      const result = await syncAmazon({ config: config.amazon, skuRecord, quantity: count.quantity });
      await recordResult(db, {
        eventId,
        catalogObjectId: count.catalogObjectId,
        sku,
        marketplace: 'amazon',
        status: result.status,
        quantity: result.quantity ?? count.quantity,
        externalId: result.externalId,
        message: result.message,
      });
    } catch (error) {
      failures.push(error);
      await recordResult(db, {
        eventId,
        catalogObjectId: count.catalogObjectId,
        sku,
        marketplace: 'amazon',
        status: 'failed',
        quantity: count.quantity,
        message: error.message,
      });
    }

    processedCount += 1;
  }

  if (failures.length) {
    const message = `${failures.length} marketplace sync failure(s): ${failures.map((error) => error.message).join(' | ')}`;
    await db.markEventFailed(eventId, message);
    throw new Error(message);
  }

  await db.markEventProcessed(eventId, { processedCount });
  logger.info('Square event processed', { eventId, processedCount });
  return { processedCount };
}
