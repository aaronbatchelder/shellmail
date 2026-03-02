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

/** Detect if URL is a Slack webhook */
function isSlackWebhook(url: string): boolean {
  return url.includes("hooks.slack.com");
}

/** Detect if URL is a Discord webhook */
function isDiscordWebhook(url: string): boolean {
  return url.includes("discord.com/api/webhooks") || url.includes("discordapp.com/api/webhooks");
}

/** Format payload for Slack */
function formatSlackPayload(payload: WebhookPayload): object {
  const emoji = payload.email.has_otp ? "🔑" : "📧";
  const otpText = payload.email.otp_code
    ? `\n*OTP Code:* \`${payload.email.otp_code}\``
    : payload.email.otp_link
    ? `\n*Verification Link:* ${payload.email.otp_link}`
    : "";

  return {
    text: `${emoji} New email for ${payload.address}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${emoji} *New Email*\n*To:* ${payload.address}\n*From:* ${payload.email.from_name || payload.email.from}\n*Subject:* ${payload.email.subject}${otpText}`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `ID: \`${payload.email.id}\` | ${new Date(payload.email.received_at).toLocaleString()}`,
          },
        ],
      },
    ],
  };
}

/** Format payload for Discord */
function formatDiscordPayload(payload: WebhookPayload): object {
  const color = payload.email.has_otp ? 0xf5c563 : 0x4ecdc4; // Golden for OTP, Ocean for regular
  const otpField = payload.email.otp_code
    ? { name: "🔑 OTP Code", value: `\`${payload.email.otp_code}\``, inline: true }
    : payload.email.otp_link
    ? { name: "🔗 Verification Link", value: payload.email.otp_link, inline: false }
    : null;

  const fields = [
    { name: "From", value: payload.email.from_name || payload.email.from, inline: true },
    { name: "Subject", value: payload.email.subject || "(no subject)", inline: true },
  ];

  if (otpField) fields.push(otpField);

  return {
    embeds: [
      {
        title: `📧 New Email for ${payload.address}`,
        color,
        fields,
        footer: {
          text: `ID: ${payload.email.id}`,
        },
        timestamp: payload.email.received_at,
      },
    ],
  };
}

/** Deliver webhook with retry logic */
export async function deliverWebhook(
  env: Env,
  addressId: string,
  webhookUrl: string,
  webhookSecret: string | null,
  payload: WebhookPayload
): Promise<boolean> {
  const logId = generateId();

  // Detect platform and format payload accordingly
  let finalPayload: object;
  let skipSignature = false;

  if (isSlackWebhook(webhookUrl)) {
    finalPayload = formatSlackPayload(payload);
    skipSignature = true; // Slack doesn't use our signatures
  } else if (isDiscordWebhook(webhookUrl)) {
    finalPayload = formatDiscordPayload(payload);
    skipSignature = true; // Discord doesn't use our signatures
  } else {
    finalPayload = payload;
  }

  const payloadJson = JSON.stringify(finalPayload);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "ShellMail-Webhook/1.0",
    "X-ShellMail-Event": payload.event,
    "X-ShellMail-Delivery": logId,
  };

  // Add signature if secret is configured and not Slack/Discord
  if (webhookSecret && !skipSignature) {
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
