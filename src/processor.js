import { extractInventoryCounts, getCurrentSquareQuantity } from './square.js';
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

function resultMessage(result, quantity) {
  return result.message || `set to ${result.quantity ?? quantity}`;
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

async function syncMarketplace({ db, config, marketplace, skuRecord, quantity, eventId }) {
  if (marketplace.startsWith('shopify:')) {
    const storeKey = marketplace.slice('shopify:'.length);
    const store = (config.shopify.allStores || config.shopify.stores || []).find((candidate) => candidate.key === storeKey);
    if (!store) {
      throw new Error(`Unknown Shopify store for retry: ${storeKey}`);
    }

    const result = await syncShopifyStore({ store, db, skuRecord, quantity, eventId });
    if (result.externalId && store.useLegacyShopifyIdColumn && (!skuRecord.ShopifyID || result.replaceLegacyShopifyId) && typeof db.updateShopifyId === 'function') {
      await db.updateShopifyId({ skuRecord, shopifyId: result.externalId });
      skuRecord.ShopifyID = result.externalId;
    }
    return result;
  }

  if (marketplace === 'walmart') {
    return syncWalmart({ config: config.walmart, skuRecord, quantity });
  }

  if (marketplace === 'amazon') {
    return syncAmazon({ config: config.amazon, skuRecord, quantity });
  }

  throw new Error(`Unsupported retry marketplace: ${marketplace}`);
}

export async function retryFailedSyncResult({ db, config, result }) {
  const marketplace = result.marketplace;
  const eventId = result.event_id;
  const quantity = Number.parseInt(result.quantity ?? '0', 10) || 0;
  const skuRecord = await db.findSkuRecord(result.square_catalog_object_id);

  if (!skuRecord) {
    throw new Error(`No SKU_Temp record found for Square catalog object ${result.square_catalog_object_id || '(missing)'}`);
  }

  const context = {
    eventId,
    squareCatalogObjectId: result.square_catalog_object_id,
    barcode: getSkuCode(skuRecord),
    sku: getSkuCode(skuRecord),
    itemName: skuRecord.ItemName || result.item_name || null,
    variantName: skuRecord.VarName || result.variant_name || null,
    vendor: skuRecord.Vendor || result.vendor || null,
    newQuantity: quantity,
  };

  try {
    const syncResult = await syncMarketplace({ db, config, marketplace, skuRecord, quantity, eventId });
    const message = resultMessage(syncResult, quantity);
    await db.updateSyncResult?.({
      id: result.id,
      status: syncResult.status,
      target: syncResult.externalId || result.target || null,
      quantity: syncResult.quantity ?? quantity,
      message,
    });
    logSyncResult({
      context: { ...context, newQuantity: syncResult.quantity ?? quantity },
      marketplace: `Retrying ${marketplace}`,
      status: syncResult.status === 'success' ? 'complete' : syncResult.status,
      target: syncResult.externalId,
      message,
    });
    if (typeof db.hasFailedSyncResults === 'function' && !(await db.hasFailedSyncResults(eventId))) {
      await db.markEventProcessed(eventId);
    }
    return { status: syncResult.status, marketplace, eventId, resultId: result.id };
  } catch (error) {
    const message = `retry set to ${quantity}; ${error.message}`;
    await db.updateSyncResult?.({
      id: result.id,
      status: 'failed',
      target: result.target || null,
      quantity,
      message,
    });
    logSyncResult({ context, marketplace: `Retrying ${marketplace}`, status: 'error', message });
    throw error;
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

    const squareCurrentQuantity = await getCurrentSquareQuantity({
      config,
      catalogObjectId: count.catalogObjectId,
      locationId: count.locationId,
    });

    if (squareCurrentQuantity !== count.quantity) {
      const message = `event wanted ${count.quantity}; using current Square quantity ${squareCurrentQuantity}`;
      count.quantity = squareCurrentQuantity;
      context.newQuantity = squareCurrentQuantity;
      logSyncResult({ context, marketplace: 'Square freshness check', status: 'complete', message });
    }

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
        if (result.externalId && store.useLegacyShopifyIdColumn && (!skuRecord.ShopifyID || result.replaceLegacyShopifyId) && typeof db.updateShopifyId === 'function') {
          await db.updateShopifyId({ skuRecord, shopifyId: result.externalId });
          skuRecord.ShopifyID = result.externalId;
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
