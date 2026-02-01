-- ClawMail MVP Schema

-- Addresses: each row is a unique email address with its own auth token
CREATE TABLE addresses (
  id            TEXT PRIMARY KEY,
  local_part    TEXT NOT NULL,
  domain        TEXT NOT NULL DEFAULT 'clawmail.dev',
  token_hash    TEXT NOT NULL,
  recovery_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(local_part, domain)
);

-- Emails: inbound messages stored per address
CREATE TABLE emails (
  id            TEXT PRIMARY KEY,
  address_id    TEXT NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
  from_addr     TEXT NOT NULL,
  from_name     TEXT,
  subject       TEXT,
  body_text     TEXT,
  body_html     TEXT,
  received_at   TEXT NOT NULL DEFAULT (datetime('now')),
  is_read       INTEGER NOT NULL DEFAULT 0,
  is_archived   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_emails_address ON emails(address_id, received_at DESC);
CREATE INDEX idx_emails_unread ON emails(address_id, is_read) WHERE is_read = 0;
