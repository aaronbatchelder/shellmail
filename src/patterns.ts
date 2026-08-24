import { Env, PatternDetectionResult } from './types';

/**
 * Detects suspicious behavioral patterns that may indicate abuse
 * Returns list of detected patterns and overall suspicion flag
 */
export async function detectAbusePatterns(
  env: Env,
  addressId: string,
  ipAddress: string | null
): Promise<PatternDetectionResult> {
  const reasons: string[] = [];

  // Pattern 1: Rapid address creation from same IP
  if (ipAddress) {
    const recentAddresses = await env.DB.prepare(
      `SELECT COUNT(*) as count
       FROM addresses
       WHERE ip_address = ?
         AND created_at > datetime('now', '-1 hour')`
    ).bind(ipAddress).first<{ count: number }>();

    if (recentAddresses && recentAddresses.count > 5) {
      reasons.push(`rapid_address_creation (${recentAddresses.count} in 1 hour from IP)`);
    }
  }

  // Pattern 2: High volume from new address (>20 sends in first 24 hours)
  const addressAge = await env.DB.prepare(
    `SELECT
       (julianday('now') - julianday(created_at)) * 24 as age_hours,
       (SELECT COUNT(*) FROM send_log WHERE address_id = addresses.id) as sends
     FROM addresses
     WHERE id = ?`
  ).bind(addressId).first<{ age_hours: number; sends: number }>();

  if (addressAge && addressAge.age_hours < 24 && addressAge.sends > 20) {
    reasons.push(`high_volume_new_address (${addressAge.sends} sends in ${addressAge.age_hours.toFixed(1)} hours)`);
  }

  // Pattern 3: Unusual sending hours (>10 sends between midnight-6am)
  const nightSends = await env.DB.prepare(
    `SELECT COUNT(*) as count
     FROM send_log
     WHERE address_id = ?
       AND cast(strftime('%H', created_at) as integer) BETWEEN 0 AND 6
       AND created_at > datetime('now', '-24 hours')`
  ).bind(addressId).first<{ count: number }>();

  if (nightSends && nightSends.count > 10) {
    reasons.push(`unusual_sending_hours (${nightSends.count} sends midnight-6am)`);
  }

  // Pattern 4: Same recipient receiving >3 emails in 24 hours
  const recipientPattern = await env.DB.prepare(
    `SELECT recipient_email, COUNT(*) as count
     FROM send_log
     WHERE address_id = ?
       AND created_at > datetime('now', '-24 hours')
     GROUP BY recipient_email
     HAVING count > 3
     LIMIT 1`
  ).bind(addressId).first<{ recipient_email: string; count: number }>();

  if (recipientPattern) {
    reasons.push(`recipient_targeting (${recipientPattern.count} emails to ${recipientPattern.recipient_email})`);
  }

  // Pattern 5: Burst sending (>5 emails within 1 minute)
  const burstSends = await env.DB.prepare(
    `SELECT COUNT(*) as count
     FROM send_log
     WHERE address_id = ?
       AND created_at > datetime('now', '-1 minute')`
  ).bind(addressId).first<{ count: number }>();

  if (burstSends && burstSends.count > 5) {
    reasons.push(`burst_sending (${burstSends.count} in 1 minute)`);
  }

  // Pattern 6: High percentage of different recipients (>90% unique = likely spam list)
  const recipientStats = await env.DB.prepare(
    `SELECT
       COUNT(*) as total_sends,
       COUNT(DISTINCT recipient_email) as unique_recipients
     FROM send_log
     WHERE address_id = ?
       AND created_at > datetime('now', '-7 days')`
  ).bind(addressId).first<{ total_sends: number; unique_recipients: number }>();

  if (recipientStats && recipientStats.total_sends >= 20) {
    const uniqueRatio = recipientStats.unique_recipients / recipientStats.total_sends;
    if (uniqueRatio > 0.90) {
      reasons.push(`high_unique_recipients (${(uniqueRatio * 100).toFixed(0)}% unique suggests bulk list)`);
    }
  }

  // Pattern 7: Multiple emails flagged by content filter
  const flaggedCount = await env.DB.prepare(
    `SELECT COUNT(*) as count
     FROM send_log
     WHERE address_id = ?
       AND flagged = 1
       AND created_at > datetime('now', '-7 days')`
  ).bind(addressId).first<{ count: number }>();

  if (flaggedCount && flaggedCount.count >= 3) {
    reasons.push(`repeated_content_violations (${flaggedCount.count} flagged emails)`);
  }

  return {
    suspicious: reasons.length > 0,
    reasons
  };
}

/**
 * Logs suspicious patterns for review
 */
export async function logAbusePattern(
  env: Env,
  addressId: string,
  ipAddress: string | null,
  patterns: PatternDetectionResult,
  action: 'flagged' | 'rate_limited' | 'suspended'
): Promise<void> {
  if (!patterns.suspicious) return;

  const severity = patterns.reasons.length >= 3 ? 'high' :
                   patterns.reasons.length >= 2 ? 'medium' : 'low';

  await env.DB.prepare(
    `INSERT INTO abuse_log (id, address_id, ip_address, abuse_type, severity, details, action_taken)
     VALUES (?, ?, ?, 'pattern_detection', ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    addressId,
    ipAddress || null,
    severity,
    `Patterns detected: ${patterns.reasons.join('; ')}`,
    action
  ).run();
}

/**
 * Checks if IP should be rate limited based on abuse history
 */
export async function shouldRateLimitIP(env: Env, ipAddress: string): Promise<boolean> {
  // Check if this IP has multiple suspended addresses
  const suspendedCount = await env.DB.prepare(
    `SELECT COUNT(*) as count
     FROM addresses
     WHERE ip_address = ?
       AND suspended = 1
       AND created_at > datetime('now', '-7 days')`
  ).bind(ipAddress).first<{ count: number }>();

  if (suspendedCount && suspendedCount.count >= 2) {
    return true;
  }

  // Check if this IP has multiple high-severity abuse logs
  const abuseCount = await env.DB.prepare(
    `SELECT COUNT(*) as count
     FROM abuse_log
     WHERE ip_address = ?
       AND severity IN ('high', 'critical')
       AND created_at > datetime('now', '-24 hours')`
  ).bind(ipAddress).first<{ count: number }>();

  if (abuseCount && abuseCount.count >= 3) {
    return true;
  }

  return false;
}
