import test from "node:test";
import assert from "node:assert/strict";
import { maybeRunCatalogReconciliation, runCatalogReconciliation } from "../src/reconciliation.js";

test("maybeRunCatalogReconciliation runs once after 7am Eastern", async () => {
  const calls = [];
  const db = {
    getReconciliationRun: async (runDate) => {
      calls.push(["get", runDate]);
      return null;
    },
    markReconciliationRun: async (run) => calls.push(["mark", run.status]),
    listActiveCatalogRecords: async () => [],
    upsertCatalogVariation: async () => ({ status: "success", changed: false, message: "Already current" }),
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/v2/catalog/search")) return jsonResponse({ objects: [], related_objects: [] });
    throw new Error(`Unexpected fetch ${url}`);
  };

  try {
    const result = await maybeRunCatalogReconciliation({
      db,
      config: testConfig(),
      now: new Date("2026-07-26T11:00:00Z"),
      transporter: { sendMail: async () => calls.push(["mail"]) },
    });

    assert.equal(result.ran, true);
    assert.deepEqual(calls[0], ["get", "2026-07-26"]);
    assert.equal(calls.some((call) => call[0] === "mail"), true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("maybeRunCatalogReconciliation does not start later in the day", async () => {
  const db = {
    getReconciliationRun: async () => null,
  };

  const result = await maybeRunCatalogReconciliation({
    db,
    config: testConfig(),
    now: new Date("2026-07-26T19:00:00Z"),
  });

  assert.deepEqual(result, { ran: false, reason: "not_due" });
});

test("runCatalogReconciliation processes Square pages and missing local deletes", async () => {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith("/v2/catalog/search")) {
      return jsonResponse({
        objects: [{
          type: "ITEM_VARIATION",
          id: "VAR123",
          updated_at: "2026-07-26T11:00:00Z",
          item_variation_data: {
            item_id: "ITEM123",
            name: "NS,Red,Test Style",
            sku: "123456789012",
            price_money: { amount: 1099, currency: "USD" },
            vendor_information: [{ vendor_id: "VENDOR", unit_cost_money: { amount: 510, currency: "USD" } }],
          },
        }],
        related_objects: [{
          type: "ITEM",
          id: "ITEM123",
          item_data: {
            name: "Catalog Item",
            category_id: "CAT123",
            tax_ids: ["TAX123"],
          },
        }, {
          type: "CATEGORY",
          id: "CAT123",
          category_data: { name: "Body" },
        }],
      });
    }
    if (String(url).endsWith("/v2/inventory/counts/batch-retrieve")) {
      return jsonResponse({ counts: [{ catalog_object_id: "VAR123", state: "IN_STOCK", quantity: "9" }] });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  const upserts = [];
  const deleted = [];
  const db = {
    markReconciliationRun: async (run) => calls.push({ runStatus: run.status }),
    listActiveCatalogRecords: async () => [
      { ID: 1, Token: "VAR123", SKU: "123456789012" },
      { ID: 2, Token: "MISSING123", SKU: "999999999999", ItemName: "Missing", VarName: "Gone" },
    ],
    upsertCatalogVariation: async (variation) => {
      upserts.push(variation);
      return { status: "success", changed: true, message: "Updated from Square catalog" };
    },
    markMissingSquareCatalogDeleted: async (record) => {
      deleted.push(record);
      return { changed: true };
    },
  };

  try {
    const result = await runCatalogReconciliation({
      db,
      config: testConfig(),
      runDate: "2026-07-26",
      transporter: { sendMail: async (message) => calls.push({ mail: message.subject }) },
    });

    assert.equal(result.ran, true);
    assert.equal(result.status, "completed");
    assert.equal(upserts[0].sku, "123456789012");
    assert.equal(upserts[0].quantity, 9);
    assert.deepEqual(deleted.map((record) => record.Token), ["MISSING123"]);
    assert.equal(result.stats.squareRecords, 1);
    assert.equal(result.stats.missingDeleted, 1);
    assert.equal(calls.some((call) => call.mail === "Square Catalog Reconciliation Complete - 2026-07-26"), true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

function testConfig() {
  return {
    square: {
      accessToken: "token",
      apiBaseUrl: "https://connect.squareup.com",
      apiVersion: "2026-07-15",
      catalogPageLimit: 100,
      locationId: "LOC123",
    },
    reconciliation: {
      enabled: true,
      time: "07:00",
      timezone: "America/New_York",
      emailEnabled: true,
    },
    summaryEmail: {
      from: "from@example.com",
      to: "to@example.com",
      smtp: {
        host: "smtp.example.com",
        port: 587,
        secure: false,
        user: "",
        password: "",
      },
    },
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}
