import dotenv from "dotenv";

dotenv.config();

export function loadConfig() {
  const allShopifyStores = parseList(process.env.SHOPIFY_STORES || "strawberry")
    .map((key) => loadShopifyStore(key));
  const shopifyStores = allShopifyStores.filter((store) => store.enabled);

  return {
    port: numberFromEnv("PORT", 8088),
    dryRun: boolFromEnv("DRY_RUN", false),
    square: {
      signatureKey: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || "",
      notificationUrl: process.env.SQUARE_WEBHOOK_NOTIFICATION_URL || ""
    },
    shopifyOauthStateSecret: process.env.SHOPIFY_OAUTH_STATE_SECRET || process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || "",
    mysql: {
      host: process.env.MYSQL_HOST || "127.0.0.1",
      port: numberFromEnv("MYSQL_PORT", 3306),
      user: process.env.MYSQL_USER || "",
      password: process.env.MYSQL_PASSWORD || "",
      database: process.env.MYSQL_DATABASE || "Strawberry"
    },
    tables: {
      sku: process.env.SKU_TABLE || "SKU_Temp",
      skuHistory: process.env.SKU_HISTORY_TABLE || "SKU_History",
      webhook: process.env.WEBHOOK_TABLE || "square_webhook_events"
    },
    worker: {
      limit: numberFromEnv("WORKER_LIMIT", 25),
      intervalMs: numberFromEnv("WORKER_INTERVAL_MS", 60000)
    },
    shopify: {
      allStores: allShopifyStores,
      stores: shopifyStores
    },
    walmart: {
      enabled: boolFromEnv("WALMART_ENABLED", false),
      baseUrl: process.env.WALMART_BASE_URL || "https://marketplace.walmartapis.com",
      clientId: process.env.WALMART_CLIENT_ID || "",
      clientSecret: process.env.WALMART_CLIENT_SECRET || "",
      shipNode: process.env.WALMART_SHIP_NODE || ""
    },
    amazon: {
      enabled: boolFromEnv("AMAZON_ENABLED", false),
      endpoint: process.env.AMAZON_ENDPOINT || "https://sellingpartnerapi-na.amazon.com",
      region: process.env.AMAZON_REGION || "us-east-1",
      marketplaceId: process.env.AMAZON_MARKETPLACE_ID || "ATVPDKIKX0DER",
      sellerId: process.env.AMAZON_SELLER_ID || "",
      clientId: process.env.AMAZON_LWA_CLIENT_ID || "",
      clientSecret: process.env.AMAZON_LWA_CLIENT_SECRET || "",
      refreshToken: process.env.AMAZON_LWA_REFRESH_TOKEN || "",
      lwaTokenUrl: process.env.AMAZON_LWA_TOKEN_URL || "https://api.amazon.com/auth/o2/token",
      awsAccessKeyId: process.env.AMAZON_AWS_ACCESS_KEY_ID || "",
      awsSecretAccessKey: process.env.AMAZON_AWS_SECRET_ACCESS_KEY || "",
      productType: process.env.AMAZON_PRODUCT_TYPE || "PRODUCT",
      fulfillmentChannelCode: process.env.AMAZON_FULFILLMENT_CHANNEL_CODE || "DEFAULT",
      randomizeVendors: new Set(parseList(process.env.AMAZON_RANDOMIZE_VENDORS || "Inis,TRF,Savannah Bee,Demdaco"))
    }
  };
}

function loadShopifyStore(key) {
  const prefix = `SHOPIFY_${key.toUpperCase()}_`;
  return {
    key,
    name: process.env[`${prefix}NAME`] || key,
    domain: process.env[`${prefix}DOMAIN`] || "",
    apiVersion: process.env[`${prefix}API_VERSION`] || "2026-07",
    accessMethod: process.env[`${prefix}ACCESS_METHOD`] || "admin_token",
    accessToken: process.env[`${prefix}ADMIN_ACCESS_TOKEN`] || "",
    refreshToken: process.env[`${prefix}REFRESH_TOKEN`] || "",
    accessTokenExpiresAt: process.env[`${prefix}ACCESS_TOKEN_EXPIRES_AT`] || "",
    refreshTokenExpiresAt: process.env[`${prefix}REFRESH_TOKEN_EXPIRES_AT`] || "",
    clientId: process.env[`${prefix}CLIENT_ID`] || "",
    clientSecret: process.env[`${prefix}CLIENT_SECRET`] || "",
    scopes: process.env[`${prefix}SCOPES`] || "read_products,write_inventory",
    redirectUri: process.env[`${prefix}REDIRECT_URI`] || "",
    expiringOfflineTokens: boolFromEnv(`${prefix}EXPIRING_OFFLINE_TOKENS`, false),
    locationId: process.env[`${prefix}LOCATION_ID`] || "",
    variantQueryTemplate: process.env[`${prefix}VARIANT_QUERY_TEMPLATE`] || "",
    useLegacyShopifyIdColumn: boolFromEnv(`${prefix}USE_LEGACY_SHOPIFY_ID_COLUMN`, key === "strawberry"),
    enabled: boolFromEnv(`${prefix}ENABLED`, true)
  };
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function boolFromEnv(key, fallback) {
  const value = process.env[key];
  if (value == null || value === "") return fallback;
  return /^(true|1|yes|on)$/i.test(value);
}

function numberFromEnv(key, fallback) {
  const value = Number.parseInt(process.env[key] || "", 10);
  return Number.isFinite(value) ? value : fallback;
}

export const config = loadConfig();
