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

/** Max stored body size per part (D1 rows are limited to ~2MB total) */
const MAX_BODY_LENGTH = 512 * 1024;

/** Split a raw MIME entity into its header block and body.
 *  Handles both CRLF and bare-LF line endings. */
function splitHeadersBody(raw: string): { headers: string; body: string } {
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");

  let index = -1;
  let separatorLength = 0;
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
    index = crlf;
    separatorLength = 4;
  } else if (lf !== -1) {
    index = lf;
    separatorLength = 2;
  }

  if (index === -1) return { headers: "", body: raw };
  return {
    headers: raw.slice(0, index),
    body: raw.slice(index + separatorLength),
  };
}

/** Get a (possibly folded) header value from a raw header block */
function getRawHeader(headers: string, name: string): string | null {
  const match = headers.match(
    new RegExp(`^${name}:[ \\t]*((?:.*(?:\\r?\\n[ \\t].*)*))`, "im")
  );
  return match ? match[1].replace(/\r?\n[ \t]+/g, " ").trim() : null;
}

/** Decode a quoted-printable string to UTF-8 text */
function decodeQuotedPrintable(input: string): string {
  const stripped = input.replace(/=\r?\n/g, ""); // soft line breaks
  const bytes: number[] = [];
  for (let i = 0; i < stripped.length; i++) {
    if (
      stripped[i] === "=" &&
      /^[0-9A-Fa-f]{2}$/.test(stripped.slice(i + 1, i + 3))
    ) {
      bytes.push(parseInt(stripped.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(stripped.charCodeAt(i) & 0xff);
    }
  }
  return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

/** Decode a base64 string to text using the given charset (defaults to UTF-8) */
function decodeBase64(input: string, charset = "utf-8"): string {
  const binary = atob(input.replace(/\s+/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder(charset).decode(bytes);
}

/** Decode a MIME entity body according to its Content-Transfer-Encoding */
function decodeBody(body: string, headers: string): string {
  const encoding = getRawHeader(headers, "content-transfer-encoding")?.toLowerCase();
  try {
    if (encoding === "base64") return decodeBase64(body);
    if (encoding === "quoted-printable") return decodeQuotedPrintable(body);
  } catch {
    // Fall through to the raw body if decoding fails
  }
  return body;
}

/** Decode RFC 2047 encoded-words in a header value (e.g. "=?UTF-8?B?...?=") */
function decodeMimeWords(value: string): string {
  // Whitespace between adjacent encoded-words is ignored per RFC 2047
  const joined = value.replace(/(\?=)\s+(=\?)/g, "$1$2");
  return joined.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (match, charset: string, enc: string, data: string) => {
      try {
        if (enc.toUpperCase() === "B") {
          return decodeBase64(data, charset.toLowerCase());
        }
        // Q-encoding: underscores are spaces, then quoted-printable
        return decodeQuotedPrintable(data.replace(/_/g, " "));
      } catch {
        return match;
      }
    }
  );
}

/** Recursively extract text/plain and text/html parts from a multipart body */
function extractParts(
  body: string,
  contentTypeHeader: string,
  depth = 0
): { text: string | null; html: string | null } {
  if (depth > 3) return { text: null, html: null };

  const boundaryMatch = contentTypeHeader.match(/boundary="?([^";\r\n]+)"?/i);
  if (!boundaryMatch) return { text: null, html: null };

  let text: string | null = null;
  let html: string | null = null;

  const segments = body.split(`--${boundaryMatch[1]}`);
  // First segment is the preamble; a segment starting with "--" is the terminator
  for (const segment of segments.slice(1)) {
    if (segment.startsWith("--")) break;

    const part = splitHeadersBody(segment.replace(/^\r?\n/, ""));
    const partType = (
      getRawHeader(part.headers, "content-type") || "text/plain"
    ).toLowerCase();

    if (partType.startsWith("multipart/")) {
      const nested = extractParts(part.body, part.headers, depth + 1);
      text = text || nested.text;
      html = html || nested.html;
    } else if (partType.startsWith("text/plain") && !text) {
      text = decodeBody(part.body, part.headers).trim();
    } else if (partType.startsWith("text/html") && !html) {
      html = decodeBody(part.body, part.headers).trim();
    }
  }

  return { text, html };
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
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
}> {
  const from = message.from;
  const to = message.to;
  const subject = decodeMimeWords(message.headers.get("subject") || "(no subject)");

  // Read the raw email and split into headers / body
  const rawEmail = await new Response(message.raw).text();
  const { headers: rawHeaders, body: rawBody } = splitHeadersBody(rawEmail);

  let bodyText: string | null = null;
  let bodyHtml: string | null = null;

  const contentType = message.headers.get("content-type") || "";

  if (contentType.includes("multipart")) {
    const extracted = extractParts(rawBody, contentType);
    bodyText = extracted.text;
    bodyHtml = extracted.html;
  } else if (contentType.includes("text/html")) {
    bodyHtml = decodeBody(rawBody, rawHeaders).trim();
  } else {
    // Default to plain text
    bodyText = decodeBody(rawBody, rawHeaders).trim();
  }

  // Cap stored body sizes to stay well under D1's row limit
  if (bodyText && bodyText.length > MAX_BODY_LENGTH) {
    bodyText = bodyText.slice(0, MAX_BODY_LENGTH);
  }
  if (bodyHtml && bodyHtml.length > MAX_BODY_LENGTH) {
    bodyHtml = bodyHtml.slice(0, MAX_BODY_LENGTH);
  }

  // Parse display name from From header
  const fromMatch = from.match(/^"?(.+?)"?\s*<.+>$/);
  const fromName = fromMatch ? decodeMimeWords(fromMatch[1].trim()) : null;

  // Extract Message-ID and threading headers
  const messageId = message.headers.get("message-id") || null;
  const inReplyTo = message.headers.get("in-reply-to") || null;
  const references = message.headers.get("references") || null;

  return { from, fromName, to, subject, bodyText, bodyHtml, rawHeaders, messageId, inReplyTo, references };
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

    // Look up the address in D1 (skip soft-deleted addresses)
    const addr = await env.DB.prepare(
      "SELECT * FROM addresses WHERE local_part = ? AND domain = ? AND deleted_at IS NULL"
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

    // Deduplicate by Message-ID — skip if we already have this exact message
    if (parsed.messageId) {
      const dupe = await env.DB.prepare(
        "SELECT id FROM emails WHERE address_id = ? AND message_id = ?"
      )
        .bind(addr.id, parsed.messageId)
        .first();

      if (dupe) {
        console.log(`Duplicate Message-ID ${parsed.messageId} for ${parsed.to}, skipping`);
        return;
      }
    }

    // Extract OTP code and link
    const otp = extractOtp(parsed.subject, parsed.bodyText, parsed.bodyHtml);

    // Calculate expiration based on plan
    const expiresAt = calculateExpiresAt(addr.plan || 'free');

    // Determine thread_id from In-Reply-To or References headers
    let threadId: string | null = null;

    if (parsed.inReplyTo || parsed.references) {
      // Look for existing thread with this message ID
      const referencedIds = [
        parsed.inReplyTo,
        ...(parsed.references?.split(/\s+/) || [])
      ].filter(Boolean);

      for (const refId of referencedIds) {
        const existing = await env.DB.prepare(
          "SELECT thread_id, message_id FROM emails WHERE address_id = ? AND (message_id = ? OR thread_id = ?)"
        )
          .bind(addr.id, refId, refId)
          .first<{ thread_id: string | null; message_id: string | null }>();

        if (existing) {
          threadId = existing.thread_id || existing.message_id;
          break;
        }
      }
    }

    // If no existing thread found but this email has a message_id, it becomes its own thread
    if (!threadId && parsed.messageId) {
      threadId = parsed.messageId;
    }

    // Store the email with OTP data and expiration
    const emailId = generateId();
    await env.DB.prepare(
      `INSERT INTO emails (id, address_id, from_addr, from_name, subject, body_text, body_html, raw_headers, otp_code, otp_link, otp_extracted, expires_at, message_id, thread_id, in_reply_to, references_header)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        expiresAt,
        parsed.messageId,
        threadId,
        parsed.inReplyTo,
        parsed.references
      )
      .run();

    // Note: never log the OTP code itself — worker logs are not a safe place for secrets
    console.log(
      `Stored email ${emailId} for ${parsed.to} from ${parsed.from}` +
      (otp.code ? ` [OTP detected]` : '') +
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
        thread_id: threadId,
        message_id: parsed.messageId,
        in_reply_to: parsed.inReplyTo,
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
