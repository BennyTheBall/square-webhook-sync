# Square Webhook Sync

Replacement for the hand-coded Square inventory webhook processor. It accepts Square `inventory.count.updated` events, prevents duplicate processing, updates the existing Strawberry database tables, and syncs the resulting quantity to Shopify, Walmart, and Amazon.

## What Changed

- Square webhook signatures are enforced before processing.
- Webhook events are claimed in a durable event table before work starts, so Square retries and duplicate deliveries do not run the same event twice.
- Credentials live in environment variables instead of source code.
- Shopify uses Admin GraphQL `2026-07` and `inventorySetQuantities`, replacing deprecated `inventorySetOnHandQuantities`.
- Multiple Shopify stores are supported. The existing Strawberry store can reuse the legacy `ShopifyID` column; NewWithTags can use Shopify's newer expiring offline token flow and should stay disabled for sync until its domain, app credentials, token, and location ID are ready.
- Marketplace results are written per channel for easier troubleshooting.

## Setup

1. Create the tables in `sql/schema.sql` on the Strawberry database.
2. Copy `.env.example` to `.env` and fill in production values.
3. Run `npm install`.
4. Start locally with `npm start`.
5. Configure Square to send the exact notification URL in `SQUARE_WEBHOOK_NOTIFICATION_URL`, including scheme, host, and path.

The webhook endpoint is:

```text
POST /webhooks/square
```

Health check:

```text
GET /healthz
```

## Shopify Stores

`SHOPIFY_STORES` is a comma-separated list of store keys. The default is:

```text
SHOPIFY_STORES=strawberry,nwt
```

Each key reads its own env group:

```text
SHOPIFY_STRAWBERRY_ENABLED=true
SHOPIFY_STRAWBERRY_DOMAIN=example.myshopify.com
SHOPIFY_STRAWBERRY_ACCESS_TOKEN=shpat_or_offline_token
SHOPIFY_STRAWBERRY_LOCATION_ID=gid://shopify/Location/123
SHOPIFY_STRAWBERRY_USE_LEGACY_SHOPIFY_ID_COLUMN=true

SHOPIFY_NWT_ENABLED=false
SHOPIFY_NWT_DOMAIN=newwithtags.myshopify.com
SHOPIFY_NWT_ACCESS_METHOD=expiring_offline_token
SHOPIFY_NWT_CLIENT_ID=
SHOPIFY_NWT_CLIENT_SECRET=
SHOPIFY_NWT_REDIRECT_URI=https://YOUR_DOMAIN/shopify/oauth/callback
SHOPIFY_NWT_SCOPES=read_products,write_inventory
SHOPIFY_NWT_EXPIRING_OFFLINE_TOKENS=true
SHOPIFY_NWT_ADMIN_ACCESS_TOKEN=
SHOPIFY_NWT_REFRESH_TOKEN=
SHOPIFY_NWT_LOCATION_ID=
SHOPIFY_NWT_USE_LEGACY_SHOPIFY_ID_COLUMN=false
```

For stores that use expiring offline tokens, connect the app once:

```text
GET /shopify/install/nwt
```

Shopify redirects back to `/shopify/oauth/callback`, the service validates Shopify's OAuth HMAC, exchanges the authorization code for an expiring offline token, and stores the token pair in `shopify_store_tokens`. Background inventory sync refreshes the token with `grant_type=refresh_token` before making Admin GraphQL calls.

If you already have a refresh token, set `SHOPIFY_NWT_REFRESH_TOKEN` and the service can refresh into a current access token on the first inventory call.

## DigitalOcean

This project includes a Dockerfile and `.do/app.yaml` for App Platform. Fill the app secrets in DigitalOcean, then deploy the repository or upload the project as the app source.

Minimum runtime secrets:

- `SQUARE_WEBHOOK_SIGNATURE_KEY`
- `SQUARE_WEBHOOK_NOTIFICATION_URL`
- `MYSQL_HOST`
- `MYSQL_USER`
- `MYSQL_PASSWORD`
- `MYSQL_DATABASE`
- `SHOPIFY_OAUTH_STATE_SECRET`

Add marketplace credentials only for channels you enable.

For production reliability, run the web service plus the retry worker. The worker reprocesses events that were claimed but failed during marketplace sync.

## Daily Database Sync

The easiest automation is to keep the manual Square dump into local MySQL, then run one local script after that import finishes. It dumps `Strawberry` from `mserver` and imports it directly into DigitalOcean Managed MySQL.

```bash
cp scripts/db-sync.env.example scripts/db-sync.env
```

Fill in the DigitalOcean database host, port, user, password, and database name in `scripts/db-sync.env`. The local defaults are:

```text
LOCAL_DB_HOST=mserver
LOCAL_DB_USER=root
LOCAL_DB_PASSWORD=
LOCAL_DB_NAME=Strawberry
```

Run the sync:

```bash
scripts/sync-local-db-to-do.sh
```

Watch the sync log:

```bash
tail -f /tmp/square-webhook-db-sync.log
```

To automate it daily on macOS after your manual Square import, run:

```bash
crontab -e
```

Add a line like this, adjusting the time:

```cron
30 6 * * * /Volumes/DevSSD/Projects/codex/SquareWebhookSync/scripts/sync-local-db-to-do.sh
```

The script does not drop the app-only `shopify_store_tokens`, `square_webhook_events`, or `square_inventory_sync_results` tables unless those same tables exist in the local dump. It also re-applies `sql/schema.sql` after each import.

## Better Way Notes

The old PHP file responded early with `fastcgi_finish_request`, which is good for Square timeouts, but it continued processing in the same request. This version records the event first, acknowledges quickly, and lets failed marketplace syncs be retried. The external inventory updates are absolute quantity sets, so retrying the same event is safe.

The Square signature mismatch path now returns `401` immediately. The old file calculated the signature but did not stop processing because the exit was commented out.

## API References Checked

- Square webhook validation: https://developer.squareup.com/docs/webhooks/step3validate
- Shopify Admin GraphQL latest: https://shopify.dev/docs/api/admin-graphql/latest
- Shopify `inventorySetQuantities`: https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventorySetQuantities
- Shopify offline access tokens: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens
- Shopify token exchange: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/token-exchange
- Walmart inventory API: https://developer.walmart.com/us-marketplace/docs/inventory-api-overview
- Amazon Listings Items API: https://developer-docs.amazon/sp-api/reference/listings-items-v2021-08-01
