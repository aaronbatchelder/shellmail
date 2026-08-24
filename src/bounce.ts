import { Env, BounceType } from './types';

/**
 * Records a bounce event and updates address bounce rate
 * Auto-suspends address if bounce rate exceeds threshold
 */
export async function recordBounce(
  env: Env,
  addressId: string,
  recipient: string,
  bounceType: BounceType,
  reason: string | null
): Promise<{ bounceRate: number; totalSends: number; suspended: boolean }> {
  // Record the bounce
  const bounceId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO bounce_tracking (id, address_id, recipient, bounce_type, reason)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(bounceId, addressId, recipient, bounceType, reason || null).run();

  // Calculate bounce rate over last 30 days
  const stats = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM send_log WHERE address_id = ? AND created_at > datetime('now', '-30 days')) as total_sends,
       (SELECT COUNT(*) FROM bounce_tracking WHERE address_id = ? AND bounce_type IN ('hard', 'complaint') AND created_at > datetime('now', '-30 days')) as hard_bounces`
  ).bind(addressId, addressId).first<{ total_sends: number; hard_bounces: number }>();

  const totalSends = stats?.total_sends || 0;
  const hardBounces = stats?.hard_bounces || 0;
  const bounceRate = totalSends > 0 ? hardBounces / totalSends : 0.0;

  // Update address bounce rate
  await env.DB.prepare(
    `UPDATE addresses SET bounce_rate_30d = ? WHERE id = ?`
  ).bind(bounceRate, addressId).run();

  // Auto-suspend if bounce rate exceeds 20% and we have at least 10 sends
  let suspended = false;
  if (bounceRate > 0.20 && totalSends >= 10) {
    await suspendAddress(
      env,
      addressId,
      'bounce_rate_exceeded',
      `Bounce rate ${(bounceRate * 100).toFixed(1)}% exceeds 20% threshold`
    );
    suspended = true;
  }

  // Also suspend immediately on complaint (spam report)
  if (bounceType === 'complaint') {
    await suspendAddress(
      env,
      addressId,
      'spam_complaint',
      'Recipient marked email as spam'
    );
    suspended = true;
  }

  return { bounceRate, totalSends, suspended };
}

/**
 * Suspends an address and logs the abuse
 */
async function suspendAddress(
  env: Env,
  addressId: string,
  reason: string,
  details: string
): Promise<void> {
  // Update address status
  await env.DB.prepare(
    `UPDATE addresses
     SET suspended = 1, suspension_reason = ?
     WHERE id = ?`
  ).bind(reason, addressId).run();

  // Log the abuse
  await env.DB.prepare(
    `INSERT INTO abuse_log (id, address_id, abuse_type, severity, details, action_taken)
     VALUES (?, ?, 'bounce_rate', 'high', ?, 'suspended')`
  ).bind(crypto.randomUUID(), addressId, details).run();
}

/**
 * Gets bounce statistics for an address
 */
export async function getBounceStats(
  env: Env,
  addressId: string
): Promise<{
  totalSends: number;
  hardBounces: number;
  softBounces: number;
  complaints: number;
  bounceRate: number;
}> {
  const stats = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM send_log WHERE address_id = ? AND created_at > datetime('now', '-30 days')) as total_sends,
       (SELECT COUNT(*) FROM bounce_tracking WHERE address_id = ? AND bounce_type = 'hard' AND created_at > datetime('now', '-30 days')) as hard_bounces,
       (SELECT COUNT(*) FROM bounce_tracking WHERE address_id = ? AND bounce_type = 'soft' AND created_at > datetime('now', '-30 days')) as soft_bounces,
       (SELECT COUNT(*) FROM bounce_tracking WHERE address_id = ? AND bounce_type = 'complaint' AND created_at > datetime('now', '-30 days')) as complaints`
  ).bind(addressId, addressId, addressId, addressId).first<{
    total_sends: number;
    hard_bounces: number;
    soft_bounces: number;
    complaints: number;
  }>();

  const totalSends = stats?.total_sends || 0;
  const hardBounces = stats?.hard_bounces || 0;
  const softBounces = stats?.soft_bounces || 0;
  const complaints = stats?.complaints || 0;
  const bounceRate = totalSends > 0 ? hardBounces / totalSends : 0.0;

  return {
    totalSends,
    hardBounces,
    softBounces,
    complaints,
    bounceRate
  };
}

/**
 * Unsuspends an address (admin action)
 */
export async function unsuspendAddress(env: Env, addressId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE addresses
     SET suspended = 0, suspension_reason = NULL
     WHERE id = ?`
  ).bind(addressId).run();

  // Log the action
  await env.DB.prepare(
    `INSERT INTO abuse_log (id, address_id, abuse_type, severity, details, action_taken)
     VALUES (?, ?, 'manual_review', 'low', 'Address unsuspended by admin', 'unsuspended')`
  ).bind(crypto.randomUUID(), addressId).run();
}
