-- Address Hold Window: soft-delete with 14-day hold for reclaim
ALTER TABLE addresses ADD COLUMN deleted_at TEXT;
ALTER TABLE addresses ADD COLUMN held_until TEXT;

-- Recovery Audit Log: track every recovery attempt
CREATE TABLE IF NOT EXISTS recovery_log (
  id TEXT PRIMARY KEY,
  address_id TEXT,
  local_part TEXT NOT NULL,
  domain TEXT NOT NULL,
  recovery_hash_matched INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_recovery_log_address ON recovery_log(local_part, domain);
CREATE INDEX IF NOT EXISTS idx_recovery_log_created ON recovery_log(created_at);
