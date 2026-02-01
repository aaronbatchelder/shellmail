-- Rate limiting table
CREATE TABLE rate_limits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_rate_limits_key ON rate_limits(key, created_at);
