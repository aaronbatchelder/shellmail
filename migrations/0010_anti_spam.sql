-- Anti-Spam Implementation: bounce tracking, content filters, abuse logging

-- Send Log: track all outbound emails for bounce/spam analysis
CREATE TABLE IF NOT EXISTS send_log (
  id TEXT PRIMARY KEY,
  address_id TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  subject TEXT,
  resend_email_id TEXT,
  bounce_type TEXT,
  content_scan_score INTEGER,
  flagged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (address_id) REFERENCES addresses(id)
);

CREATE INDEX IF NOT EXISTS idx_send_log_address ON send_log(address_id);
CREATE INDEX IF NOT EXISTS idx_send_log_created ON send_log(created_at);
CREATE INDEX IF NOT EXISTS idx_send_log_flagged ON send_log(flagged);

-- Bounce Tracking: monitor delivery failures and spam complaints
CREATE TABLE IF NOT EXISTS bounce_tracking (
  id TEXT PRIMARY KEY,
  address_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  bounce_type TEXT NOT NULL, -- 'hard', 'soft', 'complaint'
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (address_id) REFERENCES addresses(id)
);

CREATE INDEX IF NOT EXISTS idx_bounce_address ON bounce_tracking(address_id);
CREATE INDEX IF NOT EXISTS idx_bounce_created ON bounce_tracking(created_at);
CREATE INDEX IF NOT EXISTS idx_bounce_type ON bounce_tracking(bounce_type);

-- Abuse Log: track suspicious patterns and actions taken
CREATE TABLE IF NOT EXISTS abuse_log (
  id TEXT PRIMARY KEY,
  address_id TEXT NOT NULL,
  ip_address TEXT,
  abuse_type TEXT NOT NULL, -- 'content_filter', 'pattern_detection', 'rate_limit', 'bounce_rate'
  severity TEXT NOT NULL, -- 'low', 'medium', 'high', 'critical'
  details TEXT,
  action_taken TEXT, -- 'flagged', 'rate_limited', 'suspended', 'none'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (address_id) REFERENCES addresses(id)
);

CREATE INDEX IF NOT EXISTS idx_abuse_address ON abuse_log(address_id);
CREATE INDEX IF NOT EXISTS idx_abuse_severity ON abuse_log(severity);
CREATE INDEX IF NOT EXISTS idx_abuse_created ON abuse_log(created_at);
CREATE INDEX IF NOT EXISTS idx_abuse_type ON abuse_log(abuse_type);

-- Content Filters: patterns for spam detection
CREATE TABLE IF NOT EXISTS content_filters (
  id TEXT PRIMARY KEY,
  pattern_type TEXT NOT NULL, -- 'keyword', 'regex', 'domain', 'url_pattern'
  pattern TEXT NOT NULL,
  severity INTEGER NOT NULL, -- 1-100 score
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_content_filters_enabled ON content_filters(enabled);

-- Pre-populate with common spam patterns (JavaScript regex - case insensitive flag added in code)
INSERT INTO content_filters (id, pattern_type, pattern, severity, description) VALUES
  ('cf_crypto_1', 'keyword', '(bitcoin|crypto|nft|web3).{0,20}(invest|profit|earn|guaranteed)', 75, 'Crypto investment spam'),
  ('cf_pharma_1', 'keyword', '(viagra|cialis|pharmacy|prescription).{0,20}(cheap|discount|online)', 80, 'Pharmaceutical spam'),
  ('cf_urgent_1', 'keyword', '(urgent|act now|limited time|expires|hurry).{0,20}(click|claim|verify)', 60, 'Urgency manipulation'),
  ('cf_finance_1', 'keyword', '(loan|mortgage|credit|debt).{0,20}(approved|guaranteed|instant)', 65, 'Financial spam'),
  ('cf_prize_1', 'keyword', '(won|winner|prize|congratulations|claim).{0,20}(\$|money|cash|reward)', 70, 'Prize scam'),
  ('cf_allcaps', 'pattern', 'SUBJECT_ALL_CAPS', 50, 'All-caps subject line'),
  ('cf_excessive_links', 'pattern', 'EXCESSIVE_LINKS', 40, 'More than 5 links in message');

-- Add authentication and suspension columns to addresses
-- NOTE: these ALTER TABLEs are not idempotent (SQLite has no ADD COLUMN IF NOT
-- EXISTS) — run only via `wrangler d1 migrations apply`, which tracks applied
-- migrations and never re-runs this file.
ALTER TABLE addresses ADD COLUMN recovery_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE addresses ADD COLUMN oauth_provider TEXT;
ALTER TABLE addresses ADD COLUMN oauth_id TEXT;
ALTER TABLE addresses ADD COLUMN authenticated_at TEXT;
ALTER TABLE addresses ADD COLUMN bounce_rate_30d REAL NOT NULL DEFAULT 0.0;
ALTER TABLE addresses ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0;
ALTER TABLE addresses ADD COLUMN suspension_reason TEXT;
ALTER TABLE addresses ADD COLUMN ip_address TEXT;
