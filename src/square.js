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
      'Square-Version': '2026-07-16',
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
