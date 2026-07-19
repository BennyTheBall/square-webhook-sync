CREATE TABLE IF NOT EXISTS square_webhook_events (
  event_id VARCHAR(128) NOT NULL PRIMARY KEY,
  event_type VARCHAR(128) NULL,
  merchant_id VARCHAR(128) NULL,
  square_created_at DATETIME NULL,
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME NULL,
  status ENUM('received','processing','processed','duplicate','failed') NOT NULL DEFAULT 'received',
  attempt_count INT NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  payload_json JSON NOT NULL
);

CREATE TABLE IF NOT EXISTS square_inventory_sync_results (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_id VARCHAR(128) NOT NULL,
  sku VARCHAR(128) NULL,
  square_catalog_object_id VARCHAR(128) NULL,
  marketplace VARCHAR(64) NOT NULL,
  target VARCHAR(128) NULL,
  status ENUM('skipped','success','failed') NOT NULL,
  message TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_event_id (event_id),
  INDEX idx_sku (sku)
);

CREATE TABLE IF NOT EXISTS shopify_store_tokens (
  store_key VARCHAR(64) NOT NULL PRIMARY KEY,
  shop_domain VARCHAR(255) NOT NULL,
  access_method VARCHAR(64) NOT NULL,
  access_token TEXT NOT NULL,
  access_token_expires_at DATETIME NULL,
  refresh_token TEXT NULL,
  refresh_token_expires_at DATETIME NULL,
  scope TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
