import test from 'node:test';
import assert from 'node:assert/strict';
import { processSquareEvent } from '../src/processor.js';

test('processSquareEvent syncs catalog.version.updated into local catalog tables', async () => {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith('/v2/catalog/search')) {
      return jsonResponse({
        objects: [{
          type: 'ITEM_VARIATION',
          id: 'VAR123',
          updated_at: '2026-07-26T12:00:01Z',
          item_variation_data: {
            item_id: 'ITEM123',
            name: 'Blue',
            sku: '718806010009',
            price_money: { amount: 1000, currency: 'USD' },
            vendor_information: [{
              item_variation_vendor_info_data: {
                vendor_name: 'Vendor',
                unit_cost_money: { amount: 500, currency: 'USD' },
              },
            }],
          },
        }],
        related_objects: [{
          type: 'ITEM',
          id: 'ITEM123',
          item_data: {
            name: 'Catalog Item',
            description: 'Description',
            categories: [{ id: 'CAT123' }],
            tax_ids: ['TAX123'],
          },
        }],
      });
    }
    if (String(url).includes('/v2/catalog/object/CAT123')) {
      return jsonResponse({
        object: {
          type: 'CATEGORY',
          id: 'CAT123',
          category_data: { name: 'Category' },
        },
      });
    }
    if (String(url).includes('/v2/inventory/VAR123')) {
      return jsonResponse({ counts: [{ state: 'IN_STOCK', catalog_object_id: 'VAR123', quantity: '4' }] });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  const synced = [];
  const results = [];
  const processed = [];
  const db = {
    markEventProcessing: async (eventId) => calls.push({ markProcessing: eventId }),
    getCatalogSyncState: async () => ({ latest_square_time: '2026-07-26T11:00:00Z' }),
    upsertCatalogVariation: async (variation) => {
      synced.push(variation);
      return { status: 'success', changed: true, message: 'Updated from Square catalog' };
    },
    recordSyncResult: async (result) => results.push(result),
    markCatalogSyncState: async (state) => calls.push({ state }),
    markEventProcessed: async (eventId) => processed.push(eventId),
    markEventFailed: async () => assert.fail('catalog event should not fail'),
  };

  try {
    const result = await processSquareEvent({
      db,
      config: {
        square: {
          accessToken: 'token',
          apiBaseUrl: 'https://connect.squareup.com',
          apiVersion: '2026-07-15',
          catalogInitialLookbackHours: 0,
        },
        shopify: { stores: [] },
        walmart: { enabled: false },
        amazon: { enabled: false },
      },
      eventId: 'evt-catalog',
      payload: {
        type: 'catalog.version.updated',
        event_id: 'evt-catalog',
        data: { object: { catalog_version: { updated_at: '2026-07-26T12:00:00Z' } } },
      },
    });

    assert.deepEqual(result, { processedCount: 1, changedCount: 1 });
    assert.equal(calls.find((call) => call.body)?.body.begin_time, '2026-07-26T11:00:00Z');
    assert.equal(synced[0].sku, '718806010009');
    assert.equal(synced[0].cost, '5.00');
    assert.equal(synced[0].quantity, 4);
    assert.equal(results[0].marketplace, 'local-catalog');
    assert.deepEqual(processed, ['evt-catalog']);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('first catalog event without cursor uses a small event-time lookback', async () => {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith('/v2/catalog/search')) {
      return jsonResponse({ objects: [], related_objects: [] });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  const db = {
    markEventProcessing: async () => {},
    getCatalogSyncState: async () => null,
    markCatalogSyncState: async () => {},
    markEventProcessed: async () => {},
    markEventFailed: async () => assert.fail('catalog event should not fail'),
  };

  try {
    await processSquareEvent({
      db,
      config: {
        square: {
          accessToken: 'token',
          apiBaseUrl: 'https://connect.squareup.com',
          apiVersion: '2026-07-15',
          catalogInitialLookbackHours: 24,
          catalogEventLookbackMinutes: 10,
          catalogPageLimit: 100,
        },
        shopify: { stores: [] },
        walmart: { enabled: false },
        amazon: { enabled: false },
      },
      eventId: 'evt-catalog-no-cursor',
      payload: {
        type: 'catalog.version.updated',
        event_id: 'evt-catalog-no-cursor',
        data: { object: { catalog_version: { updated_at: '2026-07-26T12:00:00Z' } } },
      },
    });

    assert.equal(calls.find((call) => call.body)?.body.begin_time, '2026-07-26T11:50:00.000Z');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}
