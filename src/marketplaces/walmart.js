function walmartHeaders(config) {
  const auth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  return {
    Authorization: `Basic ${auth}`,
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    'WM_SVC.NAME': 'Walmart Marketplace',
    'WM_QOS.CORRELATION_ID': cryptoRandomId(),
  };
}

function walmartInventoryHeaders(token) {
  return {
    'WM_SEC.ACCESS_TOKEN': token,
    'WM_QOS.CORRELATION_ID': cryptoRandomId(),
    'WM_SVC.NAME': 'Walmart Service Name',
    'Content-Type': 'application/xml',
    Accept: 'application/xml',
  };
}

function cryptoRandomId() {
  return `square-sync-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function getWalmartToken(config) {
  const response = await fetch(`${config.baseUrl}/v3/token`, {
    method: 'POST',
    headers: walmartHeaders(config),
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Walmart token failed: ${response.status} ${bodyText.slice(0, 500)}`);
  }

  try {
    return JSON.parse(bodyText).access_token;
  } catch {
    const match = bodyText.match(/<access_token>([^<]+)<\/access_token>/);
    return match?.[1] || null;
  }
}

export async function syncWalmart({ config, skuRecord, quantity }) {
  if (!config.enabled) {
    return { status: 'skipped', message: 'Walmart disabled' };
  }
  if (!config.clientId || !config.clientSecret) {
    return { status: 'skipped', message: 'Missing Walmart credentials' };
  }

  const sku = skuRecord.SKU || skuRecord.Sku;
  if (!sku) {
    return { status: 'skipped', message: 'Missing Walmart SKU' };
  }

  const token = await getWalmartToken(config);
  if (!token) {
    throw new Error('Walmart token response did not include access_token');
  }

  const url = new URL(`${config.baseUrl}/v3/inventory`);
  url.searchParams.set('sku', sku);
  if (config.shipNode) {
    url.searchParams.set('shipNode', config.shipNode);
  }

  const response = await fetch(url, {
    method: 'PUT',
    headers: walmartInventoryHeaders(token),
    body: `<?xml version="1.0" encoding="UTF-8"?><inventory xmlns="http://walmart.com/"><sku>${escapeXml(sku)}</sku><quantity><unit>EACH</unit><amount>${quantity}</amount></quantity></inventory>`,
  });

  const bodyText = await response.text();
  if (!response.ok) {
    if (isWalmartSkuNotFound(response.status, bodyText)) {
      return { status: 'skipped', externalId: sku, message: 'Walmart SKU not found; not retried' };
    }
    throw new Error(`Walmart inventory failed: ${response.status} ${walmartErrorSummary(bodyText)}`);
  }

  return { status: 'success', externalId: sku };
}

export function isWalmartSkuNotFound(status, bodyText) {
  if (Number(status) !== 404) return false;
  const text = String(bodyText || "");
  return /sku[\s._-]*not[\s._-]*found/i.test(text)
    || /sku[\s\S]{0,200}not[\s\S]{0,80}found/i.test(text)
    || /not[\s\S]{0,80}found[\s\S]{0,200}sku/i.test(text)
    || /not[\s\S]{0,80}find[\s\S]{0,200}sku/i.test(text);
}

export function walmartErrorSummary(bodyText) {
  const text = String(bodyText || "").replace(/\s+/g, " ").trim();
  if (!text) return "empty response";

  try {
    const parsed = JSON.parse(text);
    const first = Array.isArray(parsed?.errors) ? parsed.errors[0] : parsed?.error?.[0] || parsed?.error || parsed;
    const code = first?.code || first?.errorCode || first?.category || "";
    const description = first?.description || first?.message || first?.info || "";
    return truncate([code, description].filter(Boolean).join(" - ") || text, 180);
  } catch {
    return truncate(text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), 180);
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}
