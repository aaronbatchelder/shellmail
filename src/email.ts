/**
 * ShellMail — Email Worker
 * Receives inbound email via Cloudflare Email Routing and stores in D1
 */

import { Env, Address } from "./types";
import { generateId } from "./auth";
import { extractOtp } from "./otp";
import { deliverWebhook, buildEmailPayload } from "./webhook";

/** Retention days by plan tier */
const RETENTION_DAYS: Record<string, number> = {
  free: 7,
  shell: 30,
  reef: 90,
};

/** Calculate expiration date based on plan */
function calculateExpiresAt(plan: string): string {
  const days = RETENTION_DAYS[plan] || RETENTION_DAYS.free;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + days);
  return expiresAt.toISOString();
}

/** Parse email stream into usable parts */
async function parseEmail(message: ForwardableEmailMessage): Promise<{
  from: string;
  fromName: string | null;
  to: string;
  subject: string;
  bodyText: string | null;
  bodyHtml: string | null;
  rawHeaders: string;
}> {
  const from = message.from;
  const to = message.to;
  const subject = message.headers.get("subject") || "(no subject)";

  // Read the raw email
  const rawEmail = await new Response(message.raw).text();

  // Extract headers (everything before first double newline)
  const headerEnd = rawEmail.indexOf("\r\n\r\n") || rawEmail.indexOf("\n\n");
  const rawHeaders = headerEnd > -1 ? rawEmail.substring(0, headerEnd) : "";

  // Basic parser — extract text and html parts
  let bodyText: string | null = null;
  let bodyHtml: string | null = null;

  const contentType = message.headers.get("content-type") || "";

  if (contentType.includes("multipart")) {
    // Extract boundary
    const boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/);
    if (boundaryMatch) {
      const boundary = boundaryMatch[1];
      const parts = rawEmail.split(`--${boundary}`);

      for (const part of parts) {
        if (part.includes("Content-Type: text/plain")) {
          const bodyStart = part.indexOf("\r\n\r\n") || part.indexOf("\n\n");
          if (bodyStart > -1) {
            bodyText = part.substring(bodyStart + 4).trim();
          }
        } else if (part.includes("Content-Type: text/html")) {
          const bodyStart = part.indexOf("\r\n\r\n") || part.indexOf("\n\n");
          if (bodyStart > -1) {
            bodyHtml = part.substring(bodyStart + 4).trim();
          }
        }
      }
    }
  } else if (contentType.includes("text/html")) {
    const bodyStart = rawEmail.indexOf("\r\n\r\n") || rawEmail.indexOf("\n\n");
    bodyHtml = bodyStart > -1 ? rawEmail.substring(bodyStart + 4).trim() : rawEmail;
  } else {
    // Default to plain text
    const bodyStart = rawEmail.indexOf("\r\n\r\n") || rawEmail.indexOf("\n\n");
    bodyText = bodyStart > -1 ? rawEmail.substring(bodyStart + 4).trim() : rawEmail;
  }

  // Parse display name from From header
  const fromMatch = from.match(/^"?(.+?)"?\s*<.+>$/);
  const fromName = fromMatch ? fromMatch[1].trim() : null;

  return { from, fromName, to, subject, bodyText, bodyHtml, rawHeaders };
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    // Attach ctx to env for use in webhook delivery
    env.ctx = ctx;
    const parsed = await parseEmail(message);

    // Extract local part from the To address
    const toMatch = parsed.to.match(/^([^@]+)@(.+)$/);
    if (!toMatch) {
      console.error(`Could not parse To address: ${parsed.to}`);
      return;
    }

    const [, localPart, domain] = toMatch;

    // Look up the address in D1
    const addr = await env.DB.prepare(
      "SELECT * FROM addresses WHERE local_part = ? AND domain = ?"
    )
      .bind(localPart.toLowerCase(), domain.toLowerCase())
      .first<Address>();

    if (!addr) {
      console.log(`No address found for ${parsed.to}, dropping email`);
      return;
    }

    if (addr.status !== "active") {
      console.log(`Address ${parsed.to} is disabled, rejecting email`);
      message.setReject("Address is disabled");
      return;
    }

    // Extract OTP code and link
    const otp = extractOtp(parsed.subject, parsed.bodyText, parsed.bodyHtml);

    // Calculate expiration based on plan
    const expiresAt = calculateExpiresAt(addr.plan || 'free');

    // Store the email with OTP data and expiration
    const emailId = generateId();
    await env.DB.prepare(
      `INSERT INTO emails (id, address_id, from_addr, from_name, subject, body_text, body_html, raw_headers, otp_code, otp_link, otp_extracted, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        emailId,
        addr.id,
        parsed.from,
        parsed.fromName,
        parsed.subject,
        parsed.bodyText,
        parsed.bodyHtml,
        parsed.rawHeaders,
        otp.code,
        otp.link,
        otp.code || otp.link ? 1 : 0,
        expiresAt
      )
      .run();

    console.log(
      `Stored email ${emailId} for ${parsed.to} from ${parsed.from}: ${parsed.subject}` +
      (otp.code ? ` [OTP: ${otp.code}]` : '') +
      (otp.link ? ` [Link detected]` : '')
    );

    // Update address activity timestamp and message count
    await env.DB.prepare(
      `UPDATE addresses SET last_activity_at = datetime('now'), messages_received = messages_received + 1 WHERE id = ?`
    )
      .bind(addr.id)
      .run();

    // Deliver webhook if configured
    if (addr.webhook_url) {
      const fullAddress = `${addr.local_part}@${addr.domain}`;
      const payload = buildEmailPayload(fullAddress, {
        id: emailId,
        from_addr: parsed.from,
        from_name: parsed.fromName,
        subject: parsed.subject,
        received_at: new Date().toISOString(),
        otp_code: otp.code,
        otp_link: otp.link,
      });

      // Fire and forget — don't block email processing
      env.ctx?.waitUntil(
        deliverWebhook(env, addr.id, addr.webhook_url, addr.webhook_secret || null, payload)
          .then(ok => console.log(`Webhook delivery ${ok ? 'succeeded' : 'failed'} for ${fullAddress}`))
          .catch(e => console.error(`Webhook error for ${fullAddress}:`, e))
      );
    }

    // Enforce message limit (FIFO) if set
    if (addr.max_messages > 0) {
      try {
        await env.DB.prepare(
          `DELETE FROM emails
           WHERE address_id = ?
           AND id NOT IN (
             SELECT id FROM emails
             WHERE address_id = ?
             ORDER BY received_at DESC
             LIMIT ?
           )`
        )
          .bind(addr.id, addr.id, addr.max_messages)
          .run();
      } catch (e) {
        console.error("Failed to enforce message limit:", e);
      }
    }
  },
} satisfies ExportedHandler<Env>;
