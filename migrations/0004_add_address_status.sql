-- Add status column to addresses
-- active: receiving mail (default)
-- disabled: rejecting mail

ALTER TABLE addresses ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
