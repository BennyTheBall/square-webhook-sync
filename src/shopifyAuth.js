import crypto from 'node:crypto';

const OFFLINE_TOKEN_TYPE = 'urn:shopify:params:oauth:token-type:offline-access-token';
const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token';
const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';

export function shopDomain(domain) {
  return String(domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
}

export function shopifyOauthUrl(store, state) {
  const shop = shopDomain(store.domain);
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set('client_id', store.clientId);
  url.searchParams.set('scope', store.scopes);
  url.searchParams.set('redirect_uri', store.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.append('grant_options[]', 'offline');
  return url.toString();
}

export function signState({ secret, storeKey, shop, nonce = crypto.randomBytes(16).toString('hex') }) {
  const payload = Buffer.from(JSON.stringify({ storeKey, shop: shopDomain(shop), nonce })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyState({ secret, state }) {
  const [payload, signature] = String(state || '').split('.');
  if (!payload || !signature) {
    return null;
  }

  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }

  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

export function verifyShopifyOauthHmac(query, clientSecret) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key === 'hmac' || key === 'signature') {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else if (value != null) {
      params.append(key, value);
    }
  }

  const message = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const expected = crypto.createHmac('sha256', clientSecret).update(message).digest('hex');
  const actual = String(query.hmac || '');
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

async function requestShopifyToken(store, body) {
  const response = await fetch(`https://${shopDomain(store.domain)}/admin/oauth/access_token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(`Shopify token request failed for ${store.key}: ${response.status} ${JSON.stringify(data).slice(0, 500)}`);
  }
  return data;
}

export async function exchangeAuthorizationCode(store, code) {
  return requestShopifyToken(store, {
    client_id: store.clientId,
    client_secret: store.clientSecret,
    code,
    expiring: store.expiringOfflineTokens ? '1' : '0',
  });
}

export async function exchangeSessionToken(store, sessionToken) {
  return requestShopifyToken(store, {
    client_id: store.clientId,
    client_secret: store.clientSecret,
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: sessionToken,
    subject_token_type: ID_TOKEN_TYPE,
    requested_token_type: OFFLINE_TOKEN_TYPE,
    expiring: store.expiringOfflineTokens ? '1' : '0',
  });
}

export async function refreshOfflineToken(store, refreshToken) {
  return requestShopifyToken(store, {
    client_id: store.clientId,
    client_secret: store.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}

export function tokenExpiryDate(secondsFromNow, skewSeconds = 60) {
  if (!secondsFromNow) {
    return null;
  }
  return new Date(Date.now() + Math.max(0, Number(secondsFromNow) - skewSeconds) * 1000);
}
