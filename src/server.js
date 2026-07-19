import express from 'express';
import { config } from './config.js';
import { createDb } from './db.js';
import { logger } from './logger.js';
import { getSquareEventId, verifySquareSignature } from './square.js';
import { processSquareEvent } from './processor.js';
import {
  exchangeAuthorizationCode,
  shopDomain,
  shopifyOauthUrl,
  signState,
  tokenExpiryDate,
  verifyShopifyOauthHmac,
  verifyState,
} from './shopifyAuth.js';

const app = express();
const db = createDb(config);

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.get('/shopify/install/:storeKey', (req, res) => {
  const store = config.shopify.allStores.find((item) => item.key === req.params.storeKey);
  if (!store) {
    res.status(404).send('Unknown Shopify store');
    return;
  }
  if (!store.clientId || !store.clientSecret || !store.redirectUri) {
    res.status(400).send('Shopify OAuth is not configured for this store');
    return;
  }
  if (!config.shopifyOauthStateSecret) {
    res.status(500).send('SHOPIFY_OAUTH_STATE_SECRET is missing');
    return;
  }

  const state = signState({
    secret: config.shopifyOauthStateSecret,
    storeKey: store.key,
    shop: store.domain,
  });
  res.redirect(shopifyOauthUrl(store, state));
});

app.get('/shopify/oauth/callback', async (req, res) => {
  const state = verifyState({ secret: config.shopifyOauthStateSecret, state: req.query.state });
  if (!state) {
    res.status(401).send('Invalid Shopify OAuth state');
    return;
  }

  const store = config.shopify.allStores.find((item) => item.key === state.storeKey);
  if (!store) {
    res.status(404).send('Unknown Shopify store');
    return;
  }

  const callbackShop = shopDomain(req.query.shop);
  if (callbackShop !== shopDomain(store.domain) || callbackShop !== state.shop) {
    res.status(401).send('Shop mismatch');
    return;
  }

  if (!verifyShopifyOauthHmac(req.query, store.clientSecret)) {
    res.status(401).send('Invalid Shopify OAuth HMAC');
    return;
  }

  try {
    const token = await exchangeAuthorizationCode(store, req.query.code);
    await db.saveShopifyToken({
      storeKey: store.key,
      shopDomain: callbackShop,
      accessMethod: store.accessMethod,
      accessToken: token.access_token,
      accessTokenExpiresAt: tokenExpiryDate(token.expires_in),
      refreshToken: token.refresh_token,
      refreshTokenExpiresAt: tokenExpiryDate(token.refresh_token_expires_in, 0),
      scope: token.scope,
    });
    res.send(`Shopify store ${store.key} connected. You can close this window.`);
  } catch (error) {
    logger.error('Shopify OAuth callback failed', { storeKey: store.key, error });
    res.status(500).send('Shopify token exchange failed');
  }
});

app.post('/webhooks/square', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const rawBody = req.body?.toString('utf8') || '';
  const signature = req.get('x-square-hmacsha256-signature');

  const validSignature = verifySquareSignature({
    signatureKey: config.square.signatureKey,
    notificationUrl: config.square.notificationUrl,
    rawBody,
    signature,
  });

  if (!validSignature) {
    logger.warn('Rejected Square webhook with invalid signature');
    res.status(401).json({ ok: false });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    res.status(400).json({ ok: false, error: 'Invalid JSON' });
    return;
  }

  const eventId = getSquareEventId(payload);
  if (!eventId) {
    res.status(400).json({ ok: false, error: 'Missing Square event ID' });
    return;
  }

  try {
    const claimed = await db.claimEvent({ eventId, payload });
    if (!claimed) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }

    res.status(202).json({ ok: true, eventId });
    setImmediate(async () => {
      try {
        await processSquareEvent({ db, config, eventId, payload });
      } catch (error) {
        logger.error('Square event processing failed', { eventId, error });
      }
    });
  } catch (error) {
    logger.error('Square webhook failed before acknowledgement', { eventId, error });
    res.status(500).json({ ok: false });
  }
});

const server = app.listen(config.port, () => {
  logger.info('SquareWebhookSync listening', { port: config.port });
});

function shutdown() {
  server.close(async () => {
    await db.close?.();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
