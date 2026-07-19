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
      quantity: Math.max(0, Number.parseInt(count.quantity ?? '0', 10) || 0),
      raw: count,
    }))
    .filter((count) => Boolean(count.catalogObjectId));
}
