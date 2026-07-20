import test from "node:test";
import assert from "node:assert/strict";
import { buildSummaryMessage, dayRangeUtc, maybeSendDailySummary } from "../src/summaryEmail.js";

test("dayRangeUtc returns an Eastern local-day UTC window", () => {
  const range = dayRangeUtc("2026-07-19", "America/New_York");

  assert.equal(range.startUtc.toISOString(), "2026-07-19T04:00:00.000Z");
  assert.equal(range.endUtc.toISOString(), "2026-07-20T04:00:00.000Z");
});

test("buildSummaryMessage includes totals, failures, and service table rows", () => {
  const message = buildSummaryMessage({
    summaryDate: "2026-07-19",
    timezone: "America/New_York",
    range: {
      startUtc: new Date("2026-07-19T04:00:00.000Z"),
      endUtc: new Date("2026-07-20T04:00:00.000Z")
    },
    summary: {
      products: { event_count: 2, sku_count: 1, result_count: 3 },
      events: [{ status: "processed", count: 2 }],
      results: [
        { marketplace: "local", status: "success", count: 1 },
        { marketplace: "shopify:strawberry", status: "failed", count: 1 }
      ],
      activity: [
        {
          event_id: "event-1",
          marketplace: "local",
          status: "success",
          quantity: 2,
          sku: "718806010009",
          item_name: "Test Item",
          variant_name: "Large",
          vendor: "Vendor",
          created_at: new Date("2026-07-19T15:30:00.000Z")
        },
        {
          event_id: "event-1",
          marketplace: "shopify:strawberry",
          status: "failed",
          quantity: 2,
          sku: "718806010009",
          item_name: "Test Item",
          variant_name: "Large",
          vendor: "Vendor",
          message: "Shopify error",
          created_at: new Date("2026-07-19T15:31:00.000Z")
        },
        {
          event_id: "event-1",
          marketplace: "walmart",
          status: "skipped",
          quantity: 2,
          sku: "718806010009",
          item_name: "Test Item",
          variant_name: "Large",
          vendor: "Vendor",
          created_at: new Date("2026-07-19T15:32:00.000Z")
        }
      ],
      failures: [
        {
          marketplace: "shopify:strawberry",
          status: "failed",
          quantity: 2,
          sku: "718806010009",
          item_name: "Test Item",
          message: "Shopify error"
        }
      ],
      recent: []
    }
  });

  assert.match(message, /Totals: 2 events, 1 products, 3 marketplace\/database updates/);
  assert.match(message, /SKU\s+\| Desc\s+\| Qty\s+\| Date\s+\| Time\s+\| DB\s+\| Strawberry\s+\| NWT\s+\| Walmart\s+\| Amazon/);
  assert.match(message, /718806010009\s+\| Test Item \| Large \| Vendor\s+\| 2\s+\| 2026-07-19\s+\| 11:32:00\s+\| yes\s+\| no\s+\|\s+\| skip/);
  assert.match(message, /shopify:strawberry: failed set to 2 718806010009 \| Test Item details=Shopify error/);
});

test("maybeSendDailySummary sends after configured time once per day", async () => {
  const sentMessages = [];
  const marked = [];
  const db = {
    getDailySummaryEmail: async () => null,
    getDailySummary: async () => ({
      products: { event_count: 1, sku_count: 1, result_count: 1 },
      events: [{ status: "processed", count: 1 }],
      results: [{ marketplace: "database", status: "success", count: 1 }],
      failures: [],
      recent: [],
      activity: [{
        event_id: "event-1",
        marketplace: "local",
        status: "success",
        quantity: 1,
        sku: "718806010009",
        item_name: "Test Item",
        created_at: new Date("2026-07-19T15:30:00.000Z")
      }]
    }),
    markDailySummaryEmail: async (result) => marked.push(result)
  };
  const transporter = {
    sendMail: async (message) => sentMessages.push(message)
  };

  const result = await maybeSendDailySummary({
    db,
    transporter,
    now: new Date("2026-07-20T03:56:00.000Z"),
    config: {
      summaryEmail: {
        enabled: true,
        time: "23:55",
        timezone: "America/New_York",
        from: "recap@example.com",
        to: "owner@example.com",
        smtp: { host: "smtp.example.com", port: 587, secure: false, user: "", password: "" }
      }
    }
  });

  assert.equal(result.sent, true);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].subject, "Square Sync Daily Recap - 2026-07-19");
  assert.match(sentMessages[0].html, /<table/);
  assert.equal(marked[0].status, "sent");
});
