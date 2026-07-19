import crypto from 'node:crypto';

const SERVICE = 'execute-api';

export function amazonAdvertisedQuantity({ skuRecord, quantity, random = Math.random }) {
  const vendor = skuRecord.Vendor || skuRecord.vendor || '';
  const cappedVendors = new Set(['Inis', 'TRF', 'Savannah Bee', 'Demdaco']);
  if (quantity > 2 && cappedVendors.has(vendor)) {
    return 2 + Math.floor(random() * Math.max(1, quantity - 1));
  }
  return quantity;
}

async function getAmazonAccessToken(config) {
  const response = await fetch(config.lwaTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: config.refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new Error(`Amazon LWA token failed: ${response.status} ${JSON.stringify(body).slice(0, 500)}`);
  }
  return body.access_token;
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function signingKey(secretAccessKey, dateStamp, region) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, 'aws4_request');
}

function signRequest({ config, method, url, body, accessToken }) {
  const parsed = new URL(url);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const canonicalUri = parsed.pathname;
  const canonicalQueryString = [...parsed.searchParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');

  const headers = {
    host: parsed.host,
    'content-type': 'application/json',
    'x-amz-access-token': accessToken,
    'x-amz-date': amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((key) => `${key}:${headers[key]}\n`)
    .join('');
  const payloadHash = sha256(body);
  const canonicalRequest = [method, canonicalUri, canonicalQueryString, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${config.region}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(config.awsSecretAccessKey, dateStamp, config.region), stringToSign, 'hex');

  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${config.awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export async function syncAmazon({ config, skuRecord, quantity }) {
  if (!config.enabled) {
    return { status: 'skipped', message: 'Amazon disabled' };
  }
  if (!config.refreshToken || !config.clientId || !config.clientSecret || !config.awsAccessKeyId || !config.awsSecretAccessKey) {
    return { status: 'skipped', message: 'Missing Amazon credentials' };
  }

  const amazonSku = skuRecord.AmazonSKU || skuRecord.amazon_sku;
  if (!amazonSku) {
    return { status: 'skipped', message: 'Missing Amazon SKU' };
  }

  const advertisedQuantity = amazonAdvertisedQuantity({ skuRecord, quantity });
  const body = JSON.stringify({
    productType: config.productType || 'PRODUCT',
    patches: [
      {
        op: 'replace',
        path: '/attributes/fulfillment_availability',
        value: [
          {
            fulfillment_channel_code: config.fulfillmentChannelCode || 'DEFAULT',
            quantity: advertisedQuantity,
          },
        ],
      },
    ],
  });

  const accessToken = await getAmazonAccessToken(config);
  const url = new URL(`${config.endpoint}/listings/2021-08-01/items/${encodeURIComponent(config.sellerId)}/${encodeURIComponent(amazonSku)}`);
  url.searchParams.set('marketplaceIds', config.marketplaceId);
  url.searchParams.set('issueLocale', 'en_US');
  const headers = signRequest({ config, method: 'PATCH', url: url.toString(), body, accessToken });

  const response = await fetch(url, { method: 'PATCH', headers, body });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Amazon listings patch failed: ${response.status} ${responseText.slice(0, 500)}`);
  }

  return { status: 'success', externalId: amazonSku, quantity: advertisedQuantity };
}
