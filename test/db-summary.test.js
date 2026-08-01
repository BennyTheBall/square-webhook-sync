import test from "node:test";
import assert from "node:assert/strict";
import { getDailySummary } from "../src/db.js";

test("getDailySummary only reports inventory sync rows", async () => {
  const queries = [];
  const db = {
    execute: async (sql) => {
      queries.push(sql);
      if (sql.includes("FROM square_webhook_events")) return [[{ status: "processed", count: 1 }]];
      if (sql.includes("COUNT(DISTINCT sku)")) return [[{ sku_count: 1, event_count: 1, result_count: 5 }]];
      return [[]];
    },
  };

  await getDailySummary(db, {
    startUtc: new Date("2026-07-31T04:00:00.000Z"),
    endUtc: new Date("2026-08-01T04:00:00.000Z"),
  });

  const eventsQuery = queries.find((sql) => sql.includes("FROM square_webhook_events"));
  assert.match(eventsQuery, /event_type = 'inventory\.count\.updated'/);

  const resultQueries = queries.filter((sql) => sql.includes("FROM square_inventory_sync_results"));
  assert.ok(resultQueries.length >= 5);
  for (const sql of resultQueries) {
    assert.match(sql, /marketplace <> 'local-catalog'/);
    assert.match(sql, /quantity IS NOT NULL/);
    assert.match(sql, /sku IS NOT NULL/);
    assert.match(sql, /sku <> ''/);
  }
});
