-- Add columns for send email feature
ALTER TABLE emails ADD COLUMN direction TEXT DEFAULT 'inbound';
ALTER TABLE emails ADD COLUMN to_addr TEXT;
ALTER TABLE emails ADD COLUMN message_id TEXT;

-- Track sent messages per address
ALTER TABLE addresses ADD COLUMN messages_sent INTEGER DEFAULT 0;

-- Index for filtering by direction
CREATE INDEX idx_emails_direction ON emails(address_id, direction);
