import { Env } from '../types';
import { getSendLimit } from '../send';

export type UpgradeMethod = 'recovery_verified' | 'oauth_google' | 'oauth_github' | 'stripe_payment';

/**
 * Upgrades an address plan based on authentication method
 *
 * Upgrade paths:
 * - recovery_verified: free → shell (50/day)
 * - oauth_google/github: free → shell (50/day)
 * - stripe_payment: any → reef (100/day)
 */
export async function upgradePlan(
  env: Env,
  addressId: string,
  method: UpgradeMethod,
  metadata?: {
    oauth_provider?: string;
    oauth_id?: string;
    stripe_customer_id?: string;
  }
): Promise<{ success: boolean; error?: string; plan?: string; dailyLimit?: number }> {
  // Get current address
  const addr = await env.DB.prepare(
    `SELECT id, plan, recovery_verified, oauth_provider, suspended
     FROM addresses
     WHERE id = ?`
  ).bind(addressId).first<{
    id: string;
    plan: string;
    recovery_verified: number;
    oauth_provider: string | null;
    suspended: number;
  }>();

  if (!addr) {
    return { success: false, error: 'Address not found' };
  }

  if (addr.suspended) {
    return { success: false, error: 'Cannot upgrade suspended address' };
  }

  let newPlan = addr.plan;
  const updates: Record<string, any> = {};

  switch (method) {
    case 'recovery_verified':
      // Upgrade free → shell
      if (addr.plan === 'free') {
        newPlan = 'shell';
      }
      updates.recovery_verified = 1;
      updates.authenticated_at = new Date().toISOString();
      break;

    case 'oauth_google':
    case 'oauth_github':
      // Upgrade free → shell
      if (addr.plan === 'free') {
        newPlan = 'shell';
      }
      if (!metadata?.oauth_provider || !metadata?.oauth_id) {
        return { success: false, error: 'OAuth provider and ID required' };
      }
      updates.oauth_provider = metadata.oauth_provider;
      updates.oauth_id = metadata.oauth_id;
      updates.authenticated_at = new Date().toISOString();
      break;

    case 'stripe_payment':
      // Upgrade any → reef
      newPlan = 'reef';
      if (!metadata?.stripe_customer_id) {
        return { success: false, error: 'Stripe customer ID required' };
      }
      updates.stripe_customer_id = metadata.stripe_customer_id;
      updates.authenticated_at = new Date().toISOString();
      break;

    default:
      return { success: false, error: 'Invalid upgrade method' };
  }

  // Update plan if changed
  if (newPlan !== addr.plan) {
    updates.plan = newPlan;
  }

  // Build UPDATE query dynamically
  const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
  const values = Object.values(updates);

  await env.DB.prepare(
    `UPDATE addresses SET ${setClause} WHERE id = ?`
  ).bind(...values, addressId).run();

  // Log the upgrade in abuse_log (as positive action)
  await env.DB.prepare(
    `INSERT INTO abuse_log (id, address_id, abuse_type, severity, details, action_taken)
     VALUES (?, ?, 'authentication', 'low', ?, 'plan_upgraded')`
  ).bind(
    crypto.randomUUID(),
    addressId,
    `Authenticated via ${method}, plan upgraded to ${newPlan}`
  ).run();

  const dailyLimit = getSendLimit(newPlan);

  return {
    success: true,
    plan: newPlan,
    dailyLimit
  };
}

/**
 * Downgrades an address plan (admin action or payment failed)
 */
export async function downgradePlan(
  env: Env,
  addressId: string,
  targetPlan: 'free' | 'shell',
  reason: string
): Promise<{ success: boolean; error?: string }> {
  const addr = await env.DB.prepare(
    `SELECT id, plan FROM addresses WHERE id = ?`
  ).bind(addressId).first<{ id: string; plan: string }>();

  if (!addr) {
    return { success: false, error: 'Address not found' };
  }

  // Can't downgrade below authentication level
  if (targetPlan === 'free') {
    // Remove authentication
    await env.DB.prepare(
      `UPDATE addresses
       SET plan = 'free',
           recovery_verified = 0,
           oauth_provider = NULL,
           oauth_id = NULL,
           stripe_customer_id = NULL
       WHERE id = ?`
    ).bind(addressId).run();
  } else if (targetPlan === 'shell') {
    // Downgrade from reef to shell (keep authentication)
    await env.DB.prepare(
      `UPDATE addresses
       SET plan = 'shell',
           stripe_customer_id = NULL
       WHERE id = ?`
    ).bind(addressId).run();
  }

  // Log the downgrade
  await env.DB.prepare(
    `INSERT INTO abuse_log (id, address_id, abuse_type, severity, details, action_taken)
     VALUES (?, ?, 'plan_change', 'medium', ?, 'plan_downgraded')`
  ).bind(
    crypto.randomUUID(),
    addressId,
    `Downgraded to ${targetPlan}: ${reason}`
  ).run();

  return { success: true };
}

/**
 * Gets effective send limit for an address considering authentication
 */
export function getEffectiveSendLimit(addr: {
  plan: string;
  recovery_verified: number;
  oauth_provider: string | null;
  stripe_customer_id: string | null;
}): number {
  const baseLimits: Record<string, number> = {
    free: 10,
    shell: 50,
    reef: 100,
  };

  // If on free plan but authenticated, use shell limits
  if (addr.plan === 'free' && (addr.recovery_verified || addr.oauth_provider || addr.stripe_customer_id)) {
    return baseLimits.shell;
  }

  return baseLimits[addr.plan] || baseLimits.free;
}
