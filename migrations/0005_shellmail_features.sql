-- ShellMail Feature Extensions
-- Adds OTP extraction, webhooks, usage tracking, custom domains

-- Add new columns to addresses for plan/billing and webhooks
ALTER TABLE addresses ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE addresses ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE addresses ADD COLUMN webhook_url TEXT;
ALTER TABLE addresses ADD COLUMN webhook_secret TEXT;
ALTER TABLE addresses ADD COLUMN messages_received INTEGER DEFAULT 0;
ALTER TABLE addresses ADD COLUMN last_activity_at TEXT;

-- Add OTP extraction columns to emails
ALTER TABLE emails ADD COLUMN raw_headers TEXT;
ALTER TABLE emails ADD COLUMN has_attachments INTEGER DEFAULT 0;
ALTER TABLE emails ADD COLUMN otp_code TEXT;
ALTER TABLE emails ADD COLUMN otp_link TEXT;
ALTER TABLE emails ADD COLUMN otp_extracted INTEGER DEFAULT 0;

-- Attachments table
CREATE TABLE attachments (
  id              TEXT PRIMARY KEY,
  email_id        TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  filename        TEXT,
  content_type    TEXT,
  size_bytes      INTEGER,
  content_base64  TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_attachments_email ON attachments(email_id);

-- Webhook delivery log
CREATE TABLE webhook_log (
  id          TEXT PRIMARY KEY,
  address_id  TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  payload     TEXT NOT NULL,
  status_code INTEGER,
  delivered   INTEGER DEFAULT 0,
  attempts    INTEGER DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_webhook_log_address ON webhook_log(address_id, created_at DESC);

-- Daily usage tracking
CREATE TABLE usage_daily (
  address_id      TEXT NOT NULL,
  date            TEXT NOT NULL,
  received        INTEGER DEFAULT 0,
  webhooks_sent   INTEGER DEFAULT 0,
  PRIMARY KEY (address_id, date)
);

-- Custom domains (paid feature)
CREATE TABLE domains (
  id                TEXT PRIMARY KEY,
  owner_address_id  TEXT NOT NULL,
  domain            TEXT UNIQUE NOT NULL,
  mx_verified       INTEGER DEFAULT 0,
  spf_verified      INTEGER DEFAULT 0,
  dkim_verified     INTEGER DEFAULT 0,
  dmarc_verified    INTEGER DEFAULT 0,
  status            TEXT DEFAULT 'pending',
  verified_at       TEXT,
  created_at        TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_domains_owner ON domains(owner_address_id);
