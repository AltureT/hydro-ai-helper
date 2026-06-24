-- Migration 0007: In-panel alert channel config (Telegram)
-- Single-row config. The bot token + chat_id are stored ONLY inside the
-- AES-GCM envelope (config_cipher/config_iv), key = HKDF(ALERT_CONFIG_KEY).
-- enabled/bot_id are non-secret. last_test_at backs the /test throttle.
-- Apply with: wrangler d1 execute <db> --remote --file migrations/0007_add_alert_channels.sql

CREATE TABLE IF NOT EXISTS plugin_alert_channels (
  id            TEXT PRIMARY KEY,   -- fixed 'telegram'
  enabled       INTEGER DEFAULT 0,
  bot_id        TEXT,
  config_cipher TEXT,
  config_iv     TEXT,
  key_version   INTEGER DEFAULT 1,
  last_test_at  TEXT,
  updated_at    TEXT
);
