CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_cooldowns (
  material_key TEXT PRIMARY KEY,
  tier_days INTEGER NOT NULL,
  notified_at TEXT NOT NULL
);
