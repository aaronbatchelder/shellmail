-- Authentication Tiers: verification codes for recovery email verification

CREATE TABLE IF NOT EXISTS verification_codes (
  id TEXT PRIMARY KEY,
  address_id TEXT NOT NULL,
  code TEXT NOT NULL,
  purpose TEXT NOT NULL, -- 'recovery_verification', 'password_reset', etc.
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (address_id) REFERENCES addresses(id)
);

CREATE INDEX IF NOT EXISTS idx_verification_address ON verification_codes(address_id);
CREATE INDEX IF NOT EXISTS idx_verification_code ON verification_codes(code);
CREATE INDEX IF NOT EXISTS idx_verification_expires ON verification_codes(expires_at);
