import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractInventoryCounts,
  getCatalogWebhookUpdatedAt,
  getSquareQuantitiesByCatalogObject,
  isCatalogVersionUpdated,
  normalizeCatalogVariations,
  verifySquareSignature,
} from '../src/square.js';

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

test('verifies Square webhook signatures against multiple keys', () => {
  const notificationUrl = 'https://example.com/webhooks/square';
  const rawBody = JSON.stringify({ event_id: 'evt_456' });
  const signature = crypto
    .createHmac('sha256', 'catalog-signature-key')
    .update(notificationUrl + rawBody)
    .digest('base64');

  assert.equal(verifySquareSignature({
    signatureKeys: ['inventory-signature-key', 'catalog-signature-key'],
    notificationUrl,
    rawBody,
    signature,
  }), true);
  assert.equal(verifySquareSignature({
    signatureKeys: ['inventory-signature-key', 'other-key'],
    notificationUrl,
    rawBody,
    signature,
  }), false);
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

test('normalizes catalog variation fields used by Strawberry tables', () => {
  const normalized = normalizeCatalogVariations({
    objects: [{
      type: 'ITEM_VARIATION',
      id: 'VARIATION123',
      updated_at: '2026-07-26T12:00:00Z',
      item_variation_data: {
        item_id: 'ITEM123',
        name: 'Small',
        sku: '718806010009',
        upc: '000718806010009',
        price_money: { amount: 1299, currency: 'USD' },
        inventory_alert_type: 'LOW_QUANTITY',
        inventory_alert_threshold: 3,
        vendor_information: [{
          item_variation_vendor_info_data: {
            vendor_name: 'Vendor Name',
            unit_cost_money: { amount: 725, currency: 'USD' },
          },
        }],
      },
    }],
    relatedObjects: [
      {
        type: 'ITEM',
        id: 'ITEM123',
        item_data: {
          name: 'Test Item',
          description_plaintext: 'A useful thing',
          category_id: 'CAT123',
          tax_ids: ['TAX123'],
        },
      },
      {
        type: 'CATEGORY',
        id: 'CAT123',
        category_data: { name: 'Gifts' },
      },
    ],
  });

  assert.deepEqual(normalized, [{
    token: 'VARIATION123',
    deleted: false,
    updatedAt: '2026-07-26T12:00:00Z',
    itemName: 'Test Item',
    description: 'A useful thing',
    category: 'Gifts',
    categoryId: 'CAT123',
    sku: '718806010009',
    gtin: '000718806010009',
    variationName: 'Small',
    price: '12.99',
    cost: '7.25',
    vendor: 'Vendor Name',
    alertEnabled: 'Y',
    alertCount: 3,
    tax: 'Y',
    raw: {
      type: 'ITEM_VARIATION',
      id: 'VARIATION123',
      updated_at: '2026-07-26T12:00:00Z',
      item_variation_data: {
        item_id: 'ITEM123',
        name: 'Small',
        sku: '718806010009',
        upc: '000718806010009',
        price_money: { amount: 1299, currency: 'USD' },
        inventory_alert_type: 'LOW_QUANTITY',
        inventory_alert_threshold: 3,
        vendor_information: [{
          item_variation_vendor_info_data: {
            vendor_name: 'Vendor Name',
            unit_cost_money: { amount: 725, currency: 'USD' },
          },
        }],
      },
    },
  }]);
});

test('detects catalog.version.updated payloads and timestamp', () => {
  const payload = {
    type: 'catalog.version.updated',
    created_at: '2026-07-26T11:59:00Z',
    data: {
      object: {
        catalog_version: {
          updated_at: '2026-07-26T12:00:00Z',
        },
      },
    },
  };

  assert.equal(isCatalogVersionUpdated(payload), true);
  assert.equal(getCatalogWebhookUpdatedAt(payload), '2026-07-26T12:00:00Z');
});

test('retries transient Square fetch failures', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      throw new TypeError('fetch failed');
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        counts: [{
          state: 'IN_STOCK',
          catalog_object_id: 'VAR123',
          quantity: '4',
        }],
      }),
    };
  };

  try {
    const quantities = await getSquareQuantitiesByCatalogObject({
      config: {
        square: {
          accessToken: 'token',
          apiBaseUrl: 'https://connect.squareup.test',
          apiVersion: '2026-07-15',
        },
      },
      catalogObjectIds: ['VAR123'],
    });

    assert.equal(calls, 2);
    assert.equal(quantities.get('VAR123'), 4);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
