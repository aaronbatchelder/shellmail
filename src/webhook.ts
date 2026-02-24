/**
 * Webhook Delivery Module
 * Sends webhook notifications when new emails arrive
 */

import { Env } from "./types";
import { generateId } from "./auth";

export interface WebhookPayload {
  event: "email.received";
  timestamp: string;
  address: string;
  email: {
    id: string;
    from: string;
    from_name: string | null;
    subject: string;
    received_at: string;
    has_otp: boolean;
    otp_code: string | null;
    otp_link: string | null;
  };
}

/** Generate HMAC-SHA256 signature for webhook payload */
async function signPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Deliver webhook with retry logic */
export async function deliverWebhook(
  env: Env,
  addressId: string,
  webhookUrl: string,
  webhookSecret: string | null,
  payload: WebhookPayload
): Promise<boolean> {
  const payloadJson = JSON.stringify(payload);
  const logId = generateId();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "ShellMail-Webhook/1.0",
    "X-ShellMail-Event": payload.event,
    "X-ShellMail-Delivery": logId,
  };

  // Add signature if secret is configured
  if (webhookSecret) {
    const signature = await signPayload(payloadJson, webhookSecret);
    headers["X-ShellMail-Signature"] = `sha256=${signature}`;
  }

  let statusCode = 0;
  let delivered = false;

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body: payloadJson,
    });

    statusCode = response.status;
    delivered = response.ok; // 2xx status codes
  } catch (e) {
    console.error(`Webhook delivery failed for ${webhookUrl}:`, e);
    statusCode = 0;
    delivered = false;
  }

  // Log the delivery attempt
  try {
    await env.DB.prepare(
      `INSERT INTO webhook_log (id, address_id, event_type, payload, status_code, delivered, attempts)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    )
      .bind(logId, addressId, payload.event, payloadJson, statusCode, delivered ? 1 : 0)
      .run();
  } catch (e) {
    console.error("Failed to log webhook delivery:", e);
  }

  return delivered;
}

/** Build webhook payload from email data */
export function buildEmailPayload(
  address: string,
  email: {
    id: string;
    from_addr: string;
    from_name: string | null;
    subject: string;
    received_at: string;
    otp_code: string | null;
    otp_link: string | null;
  }
): WebhookPayload {
  return {
    event: "email.received",
    timestamp: new Date().toISOString(),
    address,
    email: {
      id: email.id,
      from: email.from_addr,
      from_name: email.from_name,
      subject: email.subject,
      received_at: email.received_at,
      has_otp: !!(email.otp_code || email.otp_link),
      otp_code: email.otp_code,
      otp_link: email.otp_link,
    },
  };
}
