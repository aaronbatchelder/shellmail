-- Add max_messages column to addresses
-- Default to 50 as requested
-- 0 means unlimited

ALTER TABLE addresses ADD COLUMN max_messages INTEGER NOT NULL DEFAULT 50;
