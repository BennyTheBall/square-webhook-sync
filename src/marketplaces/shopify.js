import { refreshOfflineToken, shopDomain, tokenExpiryDate } from '../shopifyAuth.js';

const GRAPHQL_PATH = '/admin/api/{version}/graphql.json';

function shopifyUrl(store, path = GRAPHQL_PATH) {
  const domain = store.domain?.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `https://${domain}${path.replace('{version}', store.apiVersion)}`;
}

async function getAccessToken(store, db) {
  if (store.accessMethod === 'admin_token') {
    return store.accessToken;
  }

  const saved = await db.getShopifyToken?.(store.key);
  const envAccessToken = store.accessToken;
  const envRefreshToken = store.refreshToken;
  const accessToken = saved?.access_token || envAccessToken;
  const refreshToken = saved?.refresh_token || envRefreshToken;
  const expiresAt = saved?.access_token_expires_at || store.accessTokenExpiresAt;

  const expiring = store.accessMethod === 'expiring_offline_token' || store.expiringOfflineTokens;
  const shouldRefresh = expiring && refreshToken && (!accessToken || !expiresAt || new Date(expiresAt).getTime() <= Date.now() + 60_000);
  if (!shouldRefresh) {
    return accessToken;
  }

  const refreshed = await refreshOfflineToken(store, refreshToken);
  await db.saveShopifyToken?.({
    storeKey: store.key,
    shopDomain: shopDomain(store.domain),
    accessMethod: store.accessMethod,
    accessToken: refreshed.access_token,
    accessTokenExpiresAt: tokenExpiryDate(refreshed.expires_in),
    refreshToken: refreshed.refresh_token,
    refreshTokenExpiresAt: tokenExpiryDate(refreshed.refresh_token_expires_in, 0),
    scope: refreshed.scope,
  });
  return refreshed.access_token;
}

async function shopifyGraphql(store, db, query, variables) {
  const accessToken = await getAccessToken(store, db);
  if (!accessToken) {
    throw new Error(`Shopify ${store.key} has no access token; install/connect the app first`);
  }

  const response = await fetch(shopifyUrl(store), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errors?.length) {
    const message = body.errors?.map((error) => error.message).join('; ') || response.statusText;
    throw new Error(`Shopify ${store.key} GraphQL failed: ${message}`);
  }
  return body.data;
}

function escapeSearchValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export async function findShopifyInventoryItem(store, db, skuRecord) {
  const searchValue = skuRecord.SKU || skuRecord.Sku || skuRecord.Barcode || skuRecord.Code;
  if (!searchValue) {
    return null;
  }

  const queryText = store.variantQueryTemplate
    ? store.variantQueryTemplate.replace('{sku}', escapeSearchValue(searchValue))
    : `barcode:"${escapeSearchValue(searchValue)}" OR sku:"${escapeSearchValue(searchValue)}"`;

  const data = await shopifyGraphql(
    store,
    db,
    `query FindVariant($query: String!) {
      productVariants(first: 1, query: $query) {
        edges {
          node {
            id
            sku
            barcode
            inventoryItem { id }
          }
        }
      }
    }`,
    { query: queryText },
  );

  return data.productVariants?.edges?.[0]?.node?.inventoryItem?.id || null;
}

export async function activateInventoryAtLocation(store, db, inventoryItemId, idempotencyKey) {
  const data = await shopifyGraphql(
    store,
    db,
    `mutation ActivateInventory($inventoryItemId: ID!, $locationId: ID!, $idempotencyKey: String!) {
      inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) @idempotent(key: $idempotencyKey) {
        inventoryLevel { id }
        userErrors { field message }
      }
    }`,
    { inventoryItemId, locationId: store.locationId, idempotencyKey },
  );

  const errors = data.inventoryActivate?.userErrors || [];
  if (errors.length) {
    const ignorable = errors.every((error) => /already active/i.test(error.message || ''));
    if (!ignorable) {
      const deleted = errors.some((error) => /product (was|is) deleted|couldn'?t be stocked/i.test(error.message || ''));
      if (deleted) {
        return { skipped: true, message: errors.map((error) => error.message).join('; ') };
      }
      throw new Error(`Shopify ${store.key} inventoryActivate failed: ${errors.map((error) => error.message).join('; ')}`);
    }
  }
  return { skipped: false };
}

export async function setShopifyInventory(store, db, inventoryItemId, quantity, idempotencyKey) {
  const data = await shopifyGraphql(
    store,
    db,
    `mutation SetInventory($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
      inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
        inventoryAdjustmentGroup { createdAt reason }
        userErrors { field message }
      }
    }`,
    {
      input: {
        name: 'available',
        reason: 'correction',
        quantities: [
          {
            inventoryItemId,
            locationId: store.locationId,
            quantity,
            changeFromQuantity: null,
          },
        ],
      },
      idempotencyKey,
    },
  );

  const errors = data.inventorySetQuantities?.userErrors || [];
  if (errors.length) {
    throw new Error(`Shopify ${store.key} inventorySetQuantities failed: ${errors.map((error) => error.message).join('; ')}`);
  }
}

export async function syncShopifyStore({ store, db, skuRecord, quantity, eventId }) {
  if (!store.enabled) {
    return { status: 'skipped', message: 'Store disabled' };
  }
  if (!store.domain || !store.locationId) {
    return { status: 'skipped', message: 'Missing Shopify domain or location ID' };
  }

  const cachedId = store.useLegacyShopifyIdColumn ? skuRecord.ShopifyID : null;
  const inventoryItemId = cachedId || (await findShopifyInventoryItem(store, db, skuRecord));
  if (!inventoryItemId) {
    return { status: 'skipped', message: 'Variant not found by barcode/SKU' };
  }

  const sku = skuRecord.SKU || skuRecord.Sku || skuRecord.ID || inventoryItemId;
  const activation = await activateInventoryAtLocation(store, db, inventoryItemId, `${eventId}:${store.key}:${sku}:activate`);
  if (activation.skipped) {
    return { status: 'skipped', externalId: inventoryItemId, message: `Shopify product deleted or unavailable at location: ${activation.message}` };
  }
  await setShopifyInventory(store, db, inventoryItemId, quantity, `${eventId}:${store.key}:${sku}:set:${quantity}`);
  return { status: 'success', externalId: inventoryItemId };
}
