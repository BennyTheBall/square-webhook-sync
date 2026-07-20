import test from "node:test";
import assert from "node:assert/strict";
import { buildSummaryMessage, dayRangeUtc, maybeSendDailySummary } from "../src/summaryEmail.js";

test("dayRangeUtc returns an Eastern local-day UTC window", () => {
  const range = dayRangeUtc("2026-07-19", "America/New_York");

  assert.equal(range.startUtc.toISOString(), "2026-07-19T04:00:00.000Z");
  assert.equal(range.endUtc.toISOString(), "2026-07-20T04:00:00.000Z");
});

test("buildSummaryMessage includes totals, failures, and recent rows", () => {
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
        { marketplace: "database", status: "success", count: 1 },
        { marketplace: "shopify:strawberry", status: "failed", count: 1 }
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
      recent: [
        {
          marketplace: "database",
          status: "success",
          quantity: 2,
          sku: "718806010009",
          item_name: "Test Item"
        }
      ]
    }
  });

  assert.match(message, /Totals: 2 events, 1 products, 3 marketplace\/database updates/);
  assert.match(message, /shopify:strawberry: failed set to 2 718806010009 \| Test Item details=Shopify error/);
  assert.match(message, /database: success set to 2 718806010009 \| Test Item/);
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
      recent: []
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
  assert.equal(marked[0].status, "sent");
});
