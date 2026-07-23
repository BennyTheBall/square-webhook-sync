import test from "node:test";
import assert from "node:assert/strict";
import { retryFailedSyncResult } from "../src/processor.js";

test("retryFailedSyncResult retries only the failed marketplace row and updates it in place", async () => {
  const updates = [];
  const processedEvents = [];
  const db = {
    findSkuRecord: async (catalogObjectId) => {
      assert.equal(catalogObjectId, "square-token-1");
      return {
        ID: 1,
        Token: "square-token-1",
        SKU: "718806010009",
        ItemName: "Test Item",
        VarName: "Large",
        Quantity: 2,
        Vendor: "Vendor",
      };
    },
    updateSyncResult: async (result) => updates.push(result),
    hasFailedSyncResults: async (eventId) => {
      assert.equal(eventId, "event-1");
      return false;
    },
    markEventProcessed: async (eventId) => processedEvents.push(eventId),
  };

  const result = await retryFailedSyncResult({
    db,
    config: {
      walmart: { enabled: false },
      shopify: { stores: [], allStores: [] },
      amazon: { enabled: false },
    },
    result: {
      id: 42,
      event_id: "event-1",
      sku: "718806010009",
      square_catalog_object_id: "square-token-1",
      item_name: "Test Item",
      variant_name: "Large",
      vendor: "Vendor",
      quantity: 2,
      marketplace: "walmart",
      target: null,
      status: "failed",
      message: "previous failure",
    },
  });

  assert.deepEqual(result, {
    status: "skipped",
    marketplace: "walmart",
    eventId: "event-1",
    resultId: 42,
  });
  assert.deepEqual(updates, [{
    id: 42,
    status: "skipped",
    target: null,
    quantity: 2,
    message: "Walmart disabled",
  }]);
  assert.deepEqual(processedEvents, ["event-1"]);
});
