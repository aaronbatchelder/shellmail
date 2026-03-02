/**
 * ShellMail — Send Email via Resend
 */

import { generateId } from "./auth";

/** Send limits by plan */
const SEND_LIMITS: Record<string, number> = {
  free: 10,
  shell: 50,
  reef: 100,
};

export function getSendLimit(plan: string): number {
  return SEND_LIMITS[plan] || SEND_LIMITS.free;
}

/** Generate RFC 5322 compliant Message-ID */
export function generateMessageId(domain: string): string {
  const id = generateId();
  const timestamp = Date.now();
  return `<${timestamp}.${id}@${domain}>`;
}

export interface SendResult {
  success: boolean;
  id?: string;
  messageId?: string;
  error?: string;
}

export interface SendOptions {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

/** Send email via Resend API */
export async function sendViaResend(
  apiKey: string,
  options: SendOptions
): Promise<SendResult> {
  try {
    const body: Record<string, unknown> = {
      from: options.from,
      to: options.to,
      subject: options.subject,
      text: options.text,
    };

    if (options.html) {
      body.html = options.html;
    }

    if (options.replyTo) {
      body.reply_to = options.replyTo;
    }

    if (options.headers) {
      body.headers = options.headers;
    }

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error("Resend error:", resp.status, err);
      return { success: false, error: `Resend API error: ${resp.status}` };
    }

    const data = await resp.json() as { id: string };
    return { success: true, id: data.id };
  } catch (e) {
    console.error("Resend send failed:", e);
    return { success: false, error: "Failed to send email" };
  }
}
