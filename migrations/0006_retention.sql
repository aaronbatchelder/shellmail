-- Data retention support
-- Adds expires_at column to emails for automatic cleanup

ALTER TABLE emails ADD COLUMN expires_at TEXT;

-- Index for efficient cleanup queries
CREATE INDEX idx_emails_expires_at ON emails(expires_at);

-- Backfill existing emails with 7-day retention (free tier default)
UPDATE emails
SET expires_at = datetime(received_at, '+7 days')
WHERE expires_at IS NULL;
