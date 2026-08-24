-- Verification hardening: brute-force protection for recovery-verification OTPs
--
-- 1. Track failed attempts per code so codes can be invalidated after 5 wrong guesses
-- 2. Rename code -> code_hash: codes are now stored as SHA-256 hashes, not plaintext
--    (in-flight plaintext codes expire within 5 minutes; users just re-request)
-- 3. Drop the plaintext code index — lookups are by address_id, never by code

ALTER TABLE verification_codes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE verification_codes RENAME COLUMN code TO code_hash;
DROP INDEX IF EXISTS idx_verification_code;
