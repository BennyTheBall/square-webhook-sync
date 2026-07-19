import { extractInventoryCounts } from './square.js';
import { syncShopifyStore } from './marketplaces/shopify.js';
import { syncWalmart } from './marketplaces/walmart.js';
import { syncAmazon } from './marketplaces/amazon.js';
import { logger } from './logger.js';

function getSkuCode(skuRecord) {
  return skuRecord.SKU || skuRecord.Sku || skuRecord.Code || skuRecord.Barcode || skuRecord.Token;
}

function getItemContext({ eventId, count, skuRecord, quantity, oldQuantity }) {
  return {
    eventId,
    squareCatalogObjectId: count.catalogObjectId,
    barcode: getSkuCode(skuRecord),
    sku: getSkuCode(skuRecord),
    itemName: skuRecord.ItemName || null,
    variantName: skuRecord.VarName || null,
    vendor: skuRecord.Vendor || null,
    oldQuantity,
    newQuantity: quantity,
  };
}

function describeItem(context) {
  return [
    context.barcode || 'unknown barcode',
    context.itemName || 'unknown item',
    context.variantName || null,
    context.vendor || null,
  ].filter(Boolean).join(' | ');
}

function getCurrentQuantity(skuRecord) {
  return Number.parseInt(skuRecord.Quantity ?? skuRecord.quantity ?? '0', 10) || 0;
}

async function recordResult(db, result, context = {}) {
  if (typeof db.recordSyncResult === 'function') {
    await db.recordSyncResult({
      ...context,
      ...result,
      itemName: result.itemName ?? context.itemName,
      variantName: result.variantName ?? context.variantName,
      vendor: result.vendor ?? context.vendor,
      quantity: result.quantity ?? context.newQuantity,
    });
  }
}

function logSyncResult({ context, marketplace, status, target, message }) {
  const targetText = target ? ` target=${target}` : '';
  const details = message ? ` details=${message}` : '';
  logger.info(`${marketplace}: ${status}${targetText}${details}`, {
    eventId: context.eventId,
    barcode: context.barcode,
  });
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
    const context = getItemContext({ eventId, count, skuRecord, quantity: count.quantity, oldQuantity });

    logger.info(`ProductInfo: ${describeItem(context)} | quantity ${oldQuantity} -> ${count.quantity}`, {
      eventId,
      barcode: context.barcode,
    });

    if (oldQuantity !== count.quantity) {
      await db.updateLocalQuantity({
        skuRecord,
        quantity: count.quantity,
        oldQuantity,
        source: 'Square webhook',
      });
    }

    const localMessage = oldQuantity === count.quantity
      ? `already current at ${count.quantity}`
      : `set to ${count.quantity}`;

    await recordResult(db, {
      eventId,
      catalogObjectId: count.catalogObjectId,
      sku,
      marketplace: 'local',
      status: 'success',
      quantity: count.quantity,
      message: localMessage,
    }, context);
    logSyncResult({ context, marketplace: 'Updating Database', status: 'complete', message: localMessage });

    for (const store of config.shopify.stores) {
      const marketplace = `shopify:${store.key}`;
      try {
        const result = await syncShopifyStore({ store, db, skuRecord, quantity: count.quantity, eventId });
        if (result.externalId && store.useLegacyShopifyIdColumn && !skuRecord.ShopifyID && typeof db.updateShopifyId === 'function') {
          await db.updateShopifyId({ skuRecord, shopifyId: result.externalId });
        }
        const targetName = store.key === 'strawberry' ? 'TheStrawberryShopYork' : (store.name || store.key);
        const message = result.message || `set to ${count.quantity}`;
        await recordResult(db, {
          eventId,
          catalogObjectId: count.catalogObjectId,
          sku,
          marketplace,
          status: result.status,
          quantity: count.quantity,
          externalId: result.externalId,
          message,
        }, context);
        logSyncResult({
          context,
          marketplace: `Updating Shopify: ${targetName}`,
          status: result.status === 'success' ? 'complete' : result.status,
          target: result.externalId,
          message,
        });
      } catch (error) {
        failures.push(error);
        const targetName = store.key === 'strawberry' ? 'TheStrawberryShopYork' : (store.name || store.key);
        const message = `set to ${count.quantity}; ${error.message}`;
        await recordResult(db, {
          eventId,
          catalogObjectId: count.catalogObjectId,
          sku,
          marketplace,
          status: 'failed',
          quantity: count.quantity,
          message,
        }, context);
        logSyncResult({ context, marketplace: `Updating Shopify: ${targetName}`, status: 'error', message });
      }
    }

    try {
      const result = await syncWalmart({ config: config.walmart, skuRecord, quantity: count.quantity });
      const message = result.message || `set to ${count.quantity}`;
      await recordResult(db, {
        eventId,
        catalogObjectId: count.catalogObjectId,
        sku,
        marketplace: 'walmart',
        status: result.status,
        quantity: count.quantity,
        externalId: result.externalId,
        message,
      }, context);
      logSyncResult({
        context,
        marketplace: 'Updating Walmart',
        status: result.status === 'success' ? 'complete' : result.status,
        target: result.externalId,
        message,
      });
    } catch (error) {
      failures.push(error);
      const message = `set to ${count.quantity}; ${error.message}`;
      await recordResult(db, {
        eventId,
        catalogObjectId: count.catalogObjectId,
        sku,
        marketplace: 'walmart',
        status: 'failed',
        quantity: count.quantity,
        message,
      }, context);
      logSyncResult({ context, marketplace: 'Updating Walmart', status: 'error', message });
    }

    try {
      const result = await syncAmazon({ config: config.amazon, skuRecord, quantity: count.quantity });
      const message = result.message || `set to ${result.quantity ?? count.quantity}`;
      await recordResult(db, {
        eventId,
        catalogObjectId: count.catalogObjectId,
        sku,
        marketplace: 'amazon',
        status: result.status,
        quantity: result.quantity ?? count.quantity,
        externalId: result.externalId,
        message,
      }, { ...context, newQuantity: result.quantity ?? count.quantity });
      logSyncResult({
        context: { ...context, newQuantity: result.quantity ?? count.quantity },
        marketplace: 'Updating Amazon',
        status: result.status === 'success' ? 'complete' : result.status,
        target: result.externalId,
        message,
      });
    } catch (error) {
      failures.push(error);
      const message = `set to ${count.quantity}; ${error.message}`;
      await recordResult(db, {
        eventId,
        catalogObjectId: count.catalogObjectId,
        sku,
        marketplace: 'amazon',
        status: 'failed',
        quantity: count.quantity,
        message,
      }, context);
      logSyncResult({ context, marketplace: 'Updating Amazon', status: 'error', message });
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
