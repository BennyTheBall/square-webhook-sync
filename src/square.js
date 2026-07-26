import crypto from 'node:crypto';

export function verifySquareSignature({ signatureKey, notificationUrl, rawBody, signature }) {
  if (!signatureKey || !notificationUrl || !rawBody || !signature) {
    return false;
  }

  const hmac = crypto
    .createHmac('sha256', signatureKey)
    .update(notificationUrl + rawBody)
    .digest('base64');

  const expected = Buffer.from(hmac);
  const actual = Buffer.from(signature);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function getSquareEventId(payload) {
  return payload?.event_id || payload?.id || payload?.data?.id || null;
}

export function extractInventoryCounts(payload) {
  const counts = payload?.data?.object?.inventory_counts;
  if (!Array.isArray(counts)) {
    return [];
  }

  return counts
    .filter((count) => count?.state === 'IN_STOCK')
    .map((count) => ({
      catalogObjectId: count.catalog_object_id,
      locationId: count.location_id,
      quantity: Math.max(0, Number.parseInt(count.quantity ?? '0', 10) || 0),
      raw: count,
    }))
    .filter((count) => Boolean(count.catalogObjectId));
}

export async function getCurrentSquareQuantity({ config, catalogObjectId, locationId }) {
  if (!config.square.accessToken) {
    throw new Error('SQUARE_ACCESS_TOKEN is required to verify Square inventory freshness');
  }

  const url = new URL(`${config.square.apiBaseUrl}/v2/inventory/${encodeURIComponent(catalogObjectId)}`);
  if (locationId) {
    url.searchParams.set('location_ids', locationId);
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.square.accessToken}`,
      Accept: 'application/json',
      'Square-Version': config.square.apiVersion || '2026-07-15',
    },
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Square inventory freshness check failed: ${response.status} ${JSON.stringify(body).slice(0, 500)}`);
  }

  const counts = body.counts || [];
  const count = counts.find((item) => item.state === 'IN_STOCK' && (!locationId || item.location_id === locationId));
  return Math.max(0, Number.parseInt(count?.quantity ?? '0', 10) || 0);
}

export function isCatalogVersionUpdated(payload) {
  return payload?.type === 'catalog.version.updated';
}

export function getCatalogWebhookUpdatedAt(payload) {
  return payload?.data?.object?.catalog_version?.updated_at || payload?.created_at || null;
}

export async function searchChangedCatalogObjects({ config, beginTime }) {
  if (!config.square.accessToken) {
    throw new Error('SQUARE_ACCESS_TOKEN is required to sync Square catalog changes');
  }

  const objects = [];
  const relatedObjects = [];
  let cursor;

  do {
    const body = {
      object_types: ['ITEM_VARIATION'],
      include_deleted_objects: true,
      include_related_objects: true,
    };
    if (beginTime) body.begin_time = beginTime;
    if (cursor) body.cursor = cursor;

    const response = await fetch(`${config.square.apiBaseUrl}/v2/catalog/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.square.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Square-Version': config.square.apiVersion || '2026-07-15',
      },
      body: JSON.stringify(body),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Square catalog search failed: ${response.status} ${JSON.stringify(payload).slice(0, 500)}`);
    }

    objects.push(...(payload.objects || []));
    relatedObjects.push(...(payload.related_objects || []));
    cursor = payload.cursor;
  } while (cursor);

  return { objects, relatedObjects };
}

export function normalizeCatalogVariations({ objects, relatedObjects }) {
  const relatedById = new Map((relatedObjects || []).map((object) => [object.id, object]));
  return (objects || [])
    .filter((object) => object?.type === 'ITEM_VARIATION')
    .map((object) => normalizeCatalogVariation(object, relatedById));
}

export function normalizeCatalogVariation(object, relatedById = new Map()) {
  const variation = object.item_variation_data || {};
  const item = relatedById.get(variation.item_id);
  const itemData = item?.item_data || {};
  const categoryId = itemData.category_id || itemData.categories?.[0]?.id || itemData.reporting_category?.id || null;
  const category = categoryId ? relatedById.get(categoryId) : null;
  const vendorInfo = firstVendorInfo(variation.vendor_information);

  return {
    token: object.id,
    deleted: object.is_deleted === true,
    updatedAt: object.updated_at || null,
    itemName: emptyToNull(itemData.name),
    description: emptyToNull(itemData.description_plaintext || itemData.description || stripHtml(itemData.description_html)),
    category: emptyToNull(category?.category_data?.name || itemData.reporting_category?.name),
    sku: emptyToNull(variation.sku),
    gtin: emptyToNull(variation.upc),
    variationName: emptyToNull(variation.name),
    price: moneyToDecimal(variation.price_money),
    cost: moneyToDecimal(vendorInfo?.unit_cost_money),
    vendor: emptyToNull(vendorInfo?.vendor_name || vendorInfo?.name || vendorInfo?.vendor_id || vendorInfo?.vendor_code),
    alertEnabled: variation.inventory_alert_type && variation.inventory_alert_type !== 'NONE' ? 'Y' : 'N',
    alertCount: variation.inventory_alert_threshold ?? null,
    tax: Array.isArray(itemData.tax_ids) ? (itemData.tax_ids.length ? 'Y' : 'N') : null,
    raw: object,
  };
}

function firstVendorInfo(vendorInformation) {
  if (!Array.isArray(vendorInformation) || vendorInformation.length < 1) return null;
  return vendorInformation[0]?.item_variation_vendor_info_data || vendorInformation[0];
}

function moneyToDecimal(money) {
  if (!money || money.amount == null) return null;
  const amount = Number.parseInt(money.amount, 10);
  if (!Number.isFinite(amount)) return null;
  return (amount / 100).toFixed(2);
}

function emptyToNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function stripHtml(value) {
  if (!value) return null;
  return String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
