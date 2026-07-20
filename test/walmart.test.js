import test from "node:test";
import assert from "node:assert/strict";
import { isWalmartSkuNotFound, syncWalmart } from "../src/marketplaces/walmart.js";

test("detects Walmart SKU-not-found inventory responses", () => {
  assert.equal(isWalmartSkuNotFound(404, "SKU NOT FOUND"), true);
  assert.equal(isWalmartSkuNotFound(404, '{"code":"SKU_NOT_FOUND"}'), true);
  assert.equal(isWalmartSkuNotFound(404, "Sku-Not-Found"), true);
  assert.equal(isWalmartSkuNotFound(401, "SKU NOT FOUND"), false);
  assert.equal(isWalmartSkuNotFound(404, "Unauthorized"), false);
});

test("skips Walmart SKU-not-found responses without throwing", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/v3/token")) {
      return response(200, JSON.stringify({ access_token: "token" }));
    }
    return response(404, '{"errors":[{"code":"SKU_NOT_FOUND","description":"SKU NOT FOUND"}]}');
  };

  try {
    const result = await syncWalmart({
      config: {
        enabled: true,
        baseUrl: "https://marketplace.walmartapis.com",
        clientId: "client",
        clientSecret: "secret"
      },
      skuRecord: { SKU: "718806010009" },
      quantity: 2
    });

    assert.equal(result.status, "skipped");
    assert.equal(result.externalId, "718806010009");
    assert.equal(result.message, "Walmart SKU not found; not retried");
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body
  };
}
