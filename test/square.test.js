import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractInventoryCounts, verifySquareSignature } from '../src/square.js';

test('verifies Square webhook signatures with notification URL and raw body', () => {
  const signatureKey = 'test-signature-key';
  const notificationUrl = 'https://example.com/webhooks/square';
  const rawBody = JSON.stringify({ event_id: 'evt_123' });
  const signature = crypto
    .createHmac('sha256', signatureKey)
    .update(notificationUrl + rawBody)
    .digest('base64');

  assert.equal(verifySquareSignature({ signatureKey, notificationUrl, rawBody, signature }), true);
  assert.equal(verifySquareSignature({ signatureKey, notificationUrl, rawBody: `${rawBody}\n`, signature }), false);
});

test('extracts only in-stock inventory counts and clamps negative values', () => {
  const payload = {
    data: {
      object: {
        inventory_counts: [
          { state: 'IN_STOCK', catalog_object_id: 'abc', quantity: '5' },
          { state: 'IN_STOCK', catalog_object_id: 'def', quantity: '-2' },
          { state: 'SOLD', catalog_object_id: 'ghi', quantity: '1' },
          { state: 'IN_STOCK', quantity: '9' },
        ],
      },
    },
  };

  assert.deepEqual(extractInventoryCounts(payload), [
    {
      catalogObjectId: 'abc',
      locationId: undefined,
      quantity: 5,
      raw: { state: 'IN_STOCK', catalog_object_id: 'abc', quantity: '5' },
    },
    {
      catalogObjectId: 'def',
      locationId: undefined,
      quantity: 0,
      raw: { state: 'IN_STOCK', catalog_object_id: 'def', quantity: '-2' },
    },
  ]);
});
