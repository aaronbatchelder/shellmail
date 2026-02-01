/**
 * ClawMail — Email Worker
 * Receives inbound email via Cloudflare Email Routing and stores in D1
 */

import { Env, Address } from "./types";
import { generateId } from "./auth";

/** Parse email stream into usable parts */
async function parseEmail(message: ForwardableEmailMessage): Promise<{
  from: string;
  fromName: string | null;
  to: string;
  subject: string;
  bodyText: string | null;
  bodyHtml: string | null;
}> {
  const from = message.from;
  const to = message.to;
  const subject = message.headers.get("subject") || "(no subject)";

  // Read the raw email
  const rawEmail = await new Response(message.raw).text();

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

  return { from, fromName, to, subject, bodyText, bodyHtml };
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
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
      // Could optionally reject: message.setReject("Address not found");
      return;
    }

    if (addr.status !== "active") {
      console.log(`Address ${parsed.to} is disabled, rejection email`);
      message.setReject("Address is disabled");
      return;
    }

    // Store the email
    const emailId = generateId();
    await env.DB.prepare(
      `INSERT INTO emails (id, address_id, from_addr, from_name, subject, body_text, body_html)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        emailId,
        addr.id,
        parsed.from,
        parsed.fromName,
        parsed.subject,
        parsed.bodyText,
        parsed.bodyHtml
      )
      .run();

    console.log(
      `Stored email ${emailId} for ${parsed.to} from ${parsed.from}: ${parsed.subject}`
    );

    // Enforce message limit (FIFO) if set
    // 0 = unlimited
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
