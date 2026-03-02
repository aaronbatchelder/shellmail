-- Add threading support
-- thread_id groups related emails together

ALTER TABLE emails ADD COLUMN thread_id TEXT;
ALTER TABLE emails ADD COLUMN in_reply_to TEXT;
ALTER TABLE emails ADD COLUMN references_header TEXT;

-- Index for efficient thread lookups
CREATE INDEX idx_emails_thread ON emails(address_id, thread_id);
