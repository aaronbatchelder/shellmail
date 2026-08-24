import { Env, BounceType } from '../types';
import { recordBounce } from '../bounce';

/**
 * Resend webhook event types
 * https://resend.com/docs/dashboard/webhooks/event-types
 */
interface ResendWebhookEvent {
  type: 'email.sent' | 'email.delivered' | 'email.delivery_delayed' | 'email.bounced' | 'email.complained' | 'email.opened' | 'email.clicked';
  created_at: string;
  data: {
    email_id: string;
    from: string;
    to: string | string[];
    subject: string;
    created_at: string;
    tags?: {
      address_id?: string;
      send_log_id?: string;
    };
    bounce_reason?: string;
    delay_reason?: string;
  };
}

/**
 * Handles incoming webhooks from Resend
 * Processes bounce events, delivery failures, and spam complaints
 */
export async function handleResendWebhook(request: Request, env: Env): Promise<Response> {
  try {
    // Verify webhook signature (Resend uses Svix for webhook signing)
    const signature = request.headers.get('svix-signature');
    const timestamp = request.headers.get('svix-timestamp');
    const id = request.headers.get('svix-id');

    if (!signature || !timestamp || !id) {
      console.error('Missing Resend webhook headers');
      return jsonError('Missing webhook headers', 400);
    }

    // Fail closed: without a configured secret we cannot authenticate events,
    // and forged bounce events could suspend arbitrary addresses
    if (!env.RESEND_WEBHOOK_SECRET) {
      console.error('RESEND_WEBHOOK_SECRET not configured; rejecting webhook');
      return jsonError('Webhook not configured', 503);
    }

    const payload = await request.text();
    const valid = await verifySvixSignature(
      payload,
      { signature, timestamp, id },
      env.RESEND_WEBHOOK_SECRET
    );
    if (!valid) {
      console.error('Invalid Resend webhook signature');
      return jsonError('Invalid signature', 401);
    }

    const event: ResendWebhookEvent = JSON.parse(payload);
    console.log('Resend webhook received:', event.type, event.data.email_id);

    // Extract address_id from tags (we set this when sending)
    const addressId = event.data.tags?.address_id;
    if (!addressId) {
      console.warn('No address_id in webhook tags, skipping');
      return new Response('OK', { status: 200 });
    }

    // Get recipient email
    const recipient = Array.isArray(event.data.to) ? event.data.to[0] : event.data.to;

    // Update send_log with bounce info if we have send_log_id
    const sendLogId = event.data.tags?.send_log_id;

    // Handle different event types
    switch (event.type) {
      case 'email.bounced': {
        // Hard bounce - permanent delivery failure
        const result = await recordBounce(
          env,
          addressId,
          recipient,
          'hard',
          event.data.bounce_reason || 'Unknown bounce reason'
        );

        // Update send_log
        if (sendLogId) {
          await env.DB.prepare(
            `UPDATE send_log SET bounce_type = 'hard' WHERE id = ?`
          ).bind(sendLogId).run();
        }

        console.log(`Hard bounce recorded for ${addressId}: ${result.bounceRate.toFixed(2)} rate, suspended: ${result.suspended}`);
        break;
      }

      case 'email.complained': {
        // Spam complaint - recipient marked as spam
        const result = await recordBounce(
          env,
          addressId,
          recipient,
          'complaint',
          'Recipient marked email as spam'
        );

        // Update send_log
        if (sendLogId) {
          await env.DB.prepare(
            `UPDATE send_log SET bounce_type = 'complaint' WHERE id = ?`
          ).bind(sendLogId).run();
        }

        console.log(`Spam complaint recorded for ${addressId}, suspended: ${result.suspended}`);
        break;
      }

      case 'email.delivery_delayed': {
        // Soft bounce - temporary delivery failure
        await recordBounce(
          env,
          addressId,
          recipient,
          'soft',
          event.data.delay_reason || 'Delivery delayed'
        );

        // Update send_log
        if (sendLogId) {
          await env.DB.prepare(
            `UPDATE send_log SET bounce_type = 'soft' WHERE id = ?`
          ).bind(sendLogId).run();
        }

        console.log(`Soft bounce recorded for ${addressId}`);
        break;
      }

      case 'email.delivered': {
        // Successfully delivered - clear any previous soft bounces
        if (sendLogId) {
          await env.DB.prepare(
            `UPDATE send_log SET bounce_type = NULL WHERE id = ?`
          ).bind(sendLogId).run();
        }
        break;
      }

      default:
        // Other events (sent, opened, clicked) - we don't need to track these yet
        console.log(`Ignoring webhook event type: ${event.type}`);
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Error processing Resend webhook:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Helper to verify Svix webhook signature
 * https://docs.svix.com/receiving/verifying-payloads/how-manual
 */
export async function verifySvixSignature(
  payload: string,
  headers: {
    signature: string;
    timestamp: string;
    id: string;
  },
  secret: string
): Promise<boolean> {
  // Reject stale timestamps to prevent replay of captured events (Svix default: 5 min)
  const ts = parseInt(headers.timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    return false;
  }

  // Secret is "whsec_" + base64-encoded key bytes
  const secretB64 = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  let keyBytes: Uint8Array;
  try {
    keyBytes = Uint8Array.from(atob(secretB64), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signedContent = `${headers.id}.${headers.timestamp}.${payload}`;
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedContent));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

  // Header may contain multiple space-separated signatures: "v1,sig1 v1,sig2"
  for (const part of headers.signature.split(' ')) {
    const [version, sig] = part.split(',', 2);
    if (version === 'v1' && sig && constantTimeEqual(sig, expected)) {
      return true;
    }
  }
  return false;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
