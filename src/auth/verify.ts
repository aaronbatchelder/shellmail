import { Env, Address } from '../types';
import { generateId, hash } from '../auth';
import { sendViaResend } from '../send';

/** Max wrong guesses before a code is invalidated */
const MAX_ATTEMPTS = 5;

/**
 * Generates a 6-digit OTP code
 */
function generateOTP(): string {
  const digits = '0123456789';
  let code = '';
  const array = new Uint8Array(6);
  crypto.getRandomValues(array);

  for (let i = 0; i < 6; i++) {
    code += digits[array[i] % 10];
  }

  return code;
}

/**
 * Sends OTP code to specified recovery email after validating it matches the hash
 */
export async function requestRecoveryVerificationWithEmail(
  env: Env,
  addr: Address,
  recoveryEmail: string
): Promise<{ success: boolean; error?: string; expiresIn?: number }> {
  // Validate recovery email matches the hash on file
  const recoveryHash = await hash(recoveryEmail);

  if (recoveryHash !== addr.recovery_hash) {
    return { success: false, error: 'Recovery email does not match records' };
  }

  // Check if already verified
  if (addr.recovery_verified) {
    return { success: false, error: 'Recovery email already verified' };
  }

  // Rate limit: max 3 verification requests per hour
  const recentRequests = await env.DB.prepare(
    `SELECT COUNT(*) as count
     FROM verification_codes
     WHERE address_id = ?
       AND purpose = 'recovery_verification'
       AND created_at > datetime('now', '-1 hour')`
  ).bind(addr.id).first<{ count: number }>();

  if (recentRequests && recentRequests.count >= 3) {
    return { success: false, error: 'Too many verification requests. Try again in 1 hour.' };
  }

  // Generate OTP code — stored hashed so a DB leak doesn't expose live codes
  const code = generateOTP();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 minutes
  const verificationId = generateId();

  await env.DB.prepare(
    `INSERT INTO verification_codes (id, address_id, code_hash, purpose, expires_at)
     VALUES (?, ?, ?, 'recovery_verification', ?)`
  ).bind(verificationId, addr.id, await hash(code), expiresAt).run();

  // Send OTP email via Resend
  if (!env.RESEND_API_KEY) {
    return { success: false, error: 'Email sending not configured' };
  }

  const emailBody = `Your ShellMail verification code is: ${code}

This code expires in 5 minutes.

If you didn't request this code, you can safely ignore this email.

---
ShellMail - Email for AI Agents
https://shellmail.ai`;

  const result = await sendViaResend(env.RESEND_API_KEY, {
    from: 'ShellMail <verify@shellmail.ai>',
    to: recoveryEmail,
    subject: 'ShellMail Verification Code',
    text: emailBody,
  });

  if (!result.success) {
    return { success: false, error: 'Failed to send verification email' };
  }

  return {
    success: true,
    expiresIn: 300 // 5 minutes in seconds
  };
}

/**
 * Verifies OTP code and upgrades plan if valid
 */
export async function confirmRecoveryVerification(
  env: Env,
  addr: Address,
  code: string
): Promise<{ success: boolean; error?: string; plan?: string; dailyLimit?: number }> {
  // Check if already verified
  if (addr.recovery_verified) {
    return { success: false, error: 'Recovery email already verified' };
  }

  // Find valid verification code (attempts capped to block brute force)
  const verification = await env.DB.prepare(
    `SELECT id, code_hash, expires_at, used, attempts
     FROM verification_codes
     WHERE address_id = ?
       AND purpose = 'recovery_verification'
       AND used = 0
       AND attempts < ?
       AND expires_at > datetime('now')
     ORDER BY created_at DESC
     LIMIT 1`
  ).bind(addr.id, MAX_ATTEMPTS).first<{ id: string; code_hash: string; expires_at: string; used: number; attempts: number }>();

  if (!verification) {
    return { success: false, error: 'Invalid or expired verification code' };
  }

  // Compare hashes; wrong guesses count toward the attempt cap, and the code
  // is invalidated outright once the cap is reached
  const codeHash = await hash(code);
  if (codeHash !== verification.code_hash) {
    await env.DB.prepare(
      `UPDATE verification_codes
       SET attempts = attempts + 1,
           used = CASE WHEN attempts + 1 >= ? THEN 1 ELSE used END
       WHERE id = ?`
    ).bind(MAX_ATTEMPTS, verification.id).run();
    return { success: false, error: 'Invalid verification code' };
  }

  // Mark code as used
  await env.DB.prepare(
    `UPDATE verification_codes SET used = 1 WHERE id = ?`
  ).bind(verification.id).run();

  // Upgrade account
  const { upgradePlan } = await import('./upgrade');
  const result = await upgradePlan(env, addr.id, 'recovery_verified');

  return result;
}

/**
 * Cleans up expired verification codes (called by cron)
 */
export async function cleanupExpiredCodes(env: Env): Promise<number> {
  const result = await env.DB.prepare(
    `DELETE FROM verification_codes
     WHERE expires_at < datetime('now', '-1 day')`
  ).run();

  return result.meta.changes || 0;
}
