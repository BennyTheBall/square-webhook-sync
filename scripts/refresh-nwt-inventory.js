#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import dotenv from "dotenv";
import mysql from "mysql2/promise";

import { loadConfig } from "../src/config.js";
import { getSquareQuantitiesByCatalogObject } from "../src/square.js";

dotenv.config();

const NAS_CONFIG = "/Volumes/nas/base/terry/Strawberry Shop/EverthingConfig.php";
const DRY_RUN = !process.argv.includes("--apply");
const ACTIVE_ONLY = !process.argv.includes("--include-inactive");

const config = loadConfig();

function chunk(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) result.push(array.slice(i, i + size));
  return result;
}

function normalize(value) {
  return String(value || "").trim();
}

function nwtConfigFromPhp() {
  const code = `
    require ${JSON.stringify(NAS_CONFIG)};
    echo json_encode([
      'shop' => $NEWWITHTAGS_SHOP ?? '',
      'api_version' => $NEWWITHTAGS_API_VERSION ?? '2025-01',
      'access_token' => $NEWWITHTAGS_ACCESS_TOKEN ?? '',
      'client_id' => $NEWWITHTAGS_CLIENT_ID ?? '',
      'client_secret' => $NEWWITHTAGS_CLIENT_SECRET ?? '',
    ]);
  `;
  return JSON.parse(execFileSync("php", ["-r", code], { encoding: "utf8" }));
}

async function postJson(url, headers, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errors?.length) {
    throw new Error(`${response.status} ${JSON.stringify(body.errors || body).slice(0, 1200)}`);
  }
  return body;
}

async function nwtAccessToken(nwt) {
  if (nwt.access_token) return nwt.access_token;
  const body = await postJson(`https://${nwt.shop}/admin/oauth/access_token`, {}, {
    client_id: nwt.client_id,
    client_secret: nwt.client_secret,
    grant_type: "client_credentials",
  });
  if (!body.access_token) throw new Error("NewWithTags Shopify client credentials did not return an access token");
  return body.access_token;
}

async function shopifyGraphql(nwt, token, query, variables = {}) {
  const body = await postJson(
    `https://${nwt.shop}/admin/api/${nwt.api_version}/graphql.json`,
    { "X-Shopify-Access-Token": token },
    { query, variables },
  );
  return body.data || {};
}

async function loadLocation(nwt, token) {
  const data = await shopifyGraphql(nwt, token, `
    query {
      shop { name myshopifyDomain }
      locations(first: 20) {
        edges { node { id name isActive fulfillsOnlineOrders } }
      }
    }
  `);
  const locations = data.locations.edges.map((edge) => edge.node).filter((location) => location.isActive);
  const online = locations.filter((location) => location.fulfillsOnlineOrders);
  const location = online.length === 1 ? online[0] : locations[0];
  if (!location) throw new Error("No active NewWithTags Shopify location found");
  return { shop: data.shop, location };
}

async function loadVariants(nwt, token, locationId) {
  const variants = [];
  let cursor = null;
  do {
    const data = await shopifyGraphql(nwt, token, `
      query Variants($cursor: String, $locationId: ID!) {
        productVariants(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              sku
              barcode
              displayName
              product { id title handle status }
              inventoryItem {
                id
                inventoryLevel(locationId: $locationId) {
                  quantities(names: ["available"]) { name quantity }
                }
              }
            }
          }
        }
      }
    `, { cursor, locationId });
    for (const edge of data.productVariants.edges) variants.push(edge.node);
    cursor = data.productVariants.pageInfo.hasNextPage ? data.productVariants.pageInfo.endCursor : null;
    process.stderr.write(`Loaded ${variants.length} Shopify variants\r`);
  } while (cursor);
  process.stderr.write(`Loaded ${variants.length} Shopify variants\n`);
  return variants;
}

async function loadSkuMatches(db, lookupValues) {
  const matches = new Map();
  const values = [...new Set(lookupValues.map(normalize).filter(Boolean))];
  for (const batch of chunk(values, 1000)) {
    const [rows] = await db.query(
      `SELECT ID, Token, SKU, Quantity
         FROM \`${config.tables.skuTemp || config.tables.sku}\`
        WHERE Deleted IS NULL
          AND Token IS NOT NULL
          AND Token <> ''
          AND SKU IN (?)`,
      [batch],
    );
    for (const row of rows) {
      const key = normalize(row.SKU);
      if (!matches.has(key)) matches.set(key, []);
      matches.get(key).push(row);
    }
  }
  return matches;
}

function currentAvailable(variant) {
  const quantity = variant.inventoryItem?.inventoryLevel?.quantities?.find((item) => item.name === "available")?.quantity;
  return Math.max(0, Number.parseInt(quantity ?? "0", 10) || 0);
}

function resolveMatch(variant, skuMatches) {
  const keys = [variant.barcode, variant.sku].map(normalize).filter(Boolean);
  const seen = new Map();
  for (const key of keys) {
    for (const row of skuMatches.get(key) || []) seen.set(row.Token, row);
  }
  const rows = [...seen.values()];
  if (rows.length === 1) return { row: rows[0], lookupKeys: keys };
  return { row: null, lookupKeys: keys, ambiguousCount: rows.length };
}

async function setInventory(nwt, token, locationId, changes) {
  if (!changes.length) return;
  for (const batch of chunk(changes, 50)) {
    const data = await shopifyGraphql(nwt, token, `
      mutation SetInventory($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) {
          inventoryAdjustmentGroup { createdAt reason }
          userErrors { field message }
        }
      }
    `, {
      input: {
        name: "available",
        reason: "correction",
        ignoreCompareQuantity: true,
        quantities: batch.map((change) => ({
          inventoryItemId: change.inventoryItemId,
          locationId,
          quantity: change.squareQuantity,
        })),
      },
    });
    const errors = data.inventorySetQuantities?.userErrors || [];
    if (errors.length) throw new Error(`Shopify inventorySetQuantities failed: ${errors.map((e) => e.message).join("; ")}`);
    process.stderr.write(`Applied ${batch.length} Shopify inventory updates\n`);
  }
}

async function main() {
  const nwt = nwtConfigFromPhp();
  const token = await nwtAccessToken(nwt);
  const { shop, location } = await loadLocation(nwt, token);
  console.log(`Connected to ${shop.name} (${shop.myshopifyDomain}); location=${location.name} (${location.id})`);

  const db = await mysql.createConnection({
    ...config.mysql,
    timezone: "Z",
  });

  const variants = (await loadVariants(nwt, token, location.id))
    .filter((variant) => !ACTIVE_ONLY || variant.product?.status === "ACTIVE");
  const lookupValues = variants.flatMap((variant) => [variant.barcode, variant.sku]);
  const skuMatches = await loadSkuMatches(db, lookupValues);
  await db.end();

  const planned = [];
  const skipped = [];
  const matchedTokens = new Set();

  for (const variant of variants) {
    const match = resolveMatch(variant, skuMatches);
    if (!variant.inventoryItem?.id) {
      skipped.push({ reason: "missing_inventory_item", variant });
      continue;
    }
    if (!match.lookupKeys.length) {
      skipped.push({ reason: "missing_sku_and_barcode", variant });
      continue;
    }
    if (!match.row) {
      skipped.push({ reason: match.ambiguousCount ? "ambiguous_square_match" : "no_square_match", variant, lookupKeys: match.lookupKeys });
      continue;
    }
    planned.push({
      variant,
      skuRecord: match.row,
      currentQuantity: currentAvailable(variant),
    });
    matchedTokens.add(match.row.Token);
  }

  const squareQuantities = await getSquareQuantitiesByCatalogObject({
    config,
    catalogObjectIds: [...matchedTokens],
    locationId: config.square.locationId,
  });

  const changes = [];
  const alreadyCurrent = [];
  for (const item of planned) {
    const squareQuantity = squareQuantities.get(item.skuRecord.Token) || 0;
    const row = {
      sku: item.variant.sku,
      barcode: item.variant.barcode,
      title: item.variant.displayName,
      productStatus: item.variant.product?.status,
      inventoryItemId: item.variant.inventoryItem.id,
      squareToken: item.skuRecord.Token,
      shopifyQuantity: item.currentQuantity,
      squareQuantity,
    };
    if (item.currentQuantity === squareQuantity) alreadyCurrent.push(row);
    else changes.push(row);
  }

  console.log(JSON.stringify({
    dryRun: DRY_RUN,
    activeOnly: ACTIVE_ONLY,
    variants: variants.length,
    matched: planned.length,
    changes: changes.length,
    alreadyCurrent: alreadyCurrent.length,
    skipped: skipped.length,
    skippedByReason: skipped.reduce((acc, item) => {
      acc[item.reason] = (acc[item.reason] || 0) + 1;
      return acc;
    }, {}),
    sampleChanges: changes.slice(0, 20).map(({ inventoryItemId, ...row }) => row),
    sampleSkipped: skipped.slice(0, 20).map((item) => ({
      reason: item.reason,
      sku: item.variant.sku,
      barcode: item.variant.barcode,
      title: item.variant.displayName,
      status: item.variant.product?.status,
      lookupKeys: item.lookupKeys,
    })),
  }, null, 2));

  if (!DRY_RUN) {
    await setInventory(nwt, token, location.id, changes);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
