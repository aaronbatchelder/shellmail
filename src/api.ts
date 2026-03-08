/**
 * ShellMail — API Worker
 * REST API for managing email addresses and reading inbound mail
 */

import { Env, Address, Email, CreateAddressRequest, RecoverRequest, WebhookConfig, SendEmailRequest } from "./types";
import {
  generateToken,
  generateId,
  generateLocalPart,
  hash,
  extractToken,
  validateLocalPart,
  validateEmail,
} from "./auth";
import { sendViaResend, generateMessageId, getSendLimit } from "./send";

// ── Helpers ──────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/** Authenticate request — returns the address row or an error response */
async function authenticate(
  request: Request,
  db: D1Database
): Promise<Address | Response> {
  const token = extractToken(request);
  if (!token) return error("Missing or invalid Authorization header", 401);

  const tokenHash = await hash(token);
  const addr = await db
    .prepare("SELECT * FROM addresses WHERE token_hash = ? AND deleted_at IS NULL")
    .bind(tokenHash)
    .first<Address>();

  if (!addr) return error("Invalid token", 401);
  return addr;
}

// ── Admin Stats ─────────────────────────────────────────

async function getStats(env: Env) {
  const now = new Date();
  const today = now.toISOString().split("T")[0];
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [addresses, emails, emailsToday, emailsWeek, addressesToday] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) as count FROM addresses").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) as count FROM emails").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) as count FROM emails WHERE date(received_at) = ?").bind(today).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) as count FROM emails WHERE received_at >= ?").bind(weekAgo).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) as count FROM addresses WHERE date(created_at) = ?").bind(today).first<{ count: number }>(),
  ]);

  return {
    total_addresses: addresses?.count || 0,
    total_emails: emails?.count || 0,
    emails_today: emailsToday?.count || 0,
    emails_this_week: emailsWeek?.count || 0,
    signups_today: addressesToday?.count || 0,
    generated_at: now.toISOString(),
  };
}

// ── Routes ───────────────────────────────────────────────

// IPs exempt from rate limiting (for testing)
const WHITELISTED_IPS = ["69.5.113.226"];

/** POST /api/addresses — create a new email address */
async function createAddress(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  // Skip rate limiting for whitelisted IPs or admin secret
  const isWhitelisted = WHITELISTED_IPS.includes(ip);
  const hasAdminSecret = env.ADMIN_SECRET && request.headers.get("X-Admin-Secret") === env.ADMIN_SECRET;

  if (!isWhitelisted && !hasAdminSecret) {
    // Rate limit by IP: max 5 addresses per hour
    const ipAllowed = await checkRateLimit(
      env.DB,
      `create_ip:${ip}`,
      5,
      60 * 60 * 1000
    );
    if (!ipAllowed) {
      return error("Too many addresses created. Try again later.", 429);
    }
  }

  let body: CreateAddressRequest;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON body");
  }

  let { local, recovery_email } = body;

  // Auto-generate local part if not provided or set to "auto"
  if (!local || local === "auto") {
    local = generateLocalPart();
  }

  // Validate local part
  const localError = validateLocalPart(local);
  if (localError) return error(localError);

  // Preflight: validate recovery email before claiming address
  if (!recovery_email) {
    return error("recovery_email is required — this is how you recover your token if lost");
  }
  if (!validateEmail(recovery_email)) {
    return error("recovery_email is not a valid email address. Double-check for typos — you cannot change this later.");
  }

  // Rate limit by recovery email: max 10 addresses per day
  const recoveryHash = await hash(recovery_email);
  if (!isWhitelisted && !hasAdminSecret) {
    const emailAllowed = await checkRateLimit(
      env.DB,
      `create_email:${recoveryHash}`,
      10,
      24 * 60 * 60 * 1000
    );
    if (!emailAllowed) {
      return error("Too many addresses for this recovery email. Try again tomorrow.", 429);
    }
  }

  // Check availability — allow reclaim of held addresses by the original owner
  const existing = await env.DB.prepare(
    "SELECT id, deleted_at, held_until, recovery_hash FROM addresses WHERE local_part = ? AND domain = ?"
  )
    .bind(local.toLowerCase(), env.DOMAIN)
    .first<{ id: string; deleted_at: string | null; held_until: string | null; recovery_hash: string }>();

  if (existing) {
    const now = new Date().toISOString();
    const isHeld = existing.deleted_at && existing.held_until && existing.held_until > now;
    const isExpiredHold = existing.deleted_at && existing.held_until && existing.held_until <= now;

    if (!existing.deleted_at) {
      // Active address — taken
      return error(`${local}@${env.DOMAIN} is already taken`, 409);
    } else if (isHeld && existing.recovery_hash === recoveryHash) {
      // Held address, same owner — reclaim it
      const token = generateToken();
      const tokenHash = await hash(token);
      await env.DB.prepare(
        "UPDATE addresses SET token_hash = ?, recovery_hash = ?, deleted_at = NULL, held_until = NULL, status = 'active' WHERE id = ?"
      )
        .bind(tokenHash, recoveryHash, existing.id)
        .run();

      return json(
        {
          address: `${local.toLowerCase()}@${env.DOMAIN}`,
          token,
          reclaimed: true,
          note: "Address reclaimed. Save this token — it will not be shown again.",
        },
        201
      );
    } else if (isHeld) {
      // Held by a different owner — can't take it yet
      return error(`${local}@${env.DOMAIN} is reserved and cannot be claimed yet`, 409);
    } else if (isExpiredHold) {
      // Hold expired — delete the old row and allow fresh creation
      await env.DB.prepare("DELETE FROM addresses WHERE id = ?")
        .bind(existing.id)
        .run();
    }
  }

  // Generate token and IDs
  const id = generateId();
  const token = generateToken();
  const tokenHash = await hash(token);
  // recoveryHash already computed above for rate limiting

  await env.DB.prepare(
    "INSERT INTO addresses (id, local_part, domain, token_hash, recovery_hash) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(id, local.toLowerCase(), env.DOMAIN, tokenHash, recoveryHash)
    .run();

  return json(
    {
      address: `${local.toLowerCase()}@${env.DOMAIN}`,
      token,
      note: "Save this token — it will not be shown again.",
    },
    201
  );
}

/** Simple rate limiter using D1 — max attempts per address per hour */
async function checkRateLimit(
  db: D1Database,
  key: string,
  maxAttempts: number,
  windowMs: number
): Promise<boolean> {
  const windowStart = new Date(Date.now() - windowMs).toISOString();

  // Clean old entries
  await db
    .prepare("DELETE FROM rate_limits WHERE key = ? AND created_at < ?")
    .bind(key, windowStart)
    .run();

  // Count recent attempts
  const count = await db
    .prepare(
      "SELECT COUNT(*) as cnt FROM rate_limits WHERE key = ? AND created_at >= ?"
    )
    .bind(key, windowStart)
    .first<{ cnt: number }>();

  if ((count?.cnt || 0) >= maxAttempts) return false;

  // Record this attempt
  await db
    .prepare("INSERT INTO rate_limits (key, created_at) VALUES (?, ?)")
    .bind(key, new Date().toISOString())
    .run();

  return true;
}

/** POST /api/recover — request token recovery via email */
async function recoverToken(request: Request, env: Env): Promise<Response> {
  let body: RecoverRequest;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON body");
  }

  const { address, recovery_email } = body;

  if (!address || !recovery_email) {
    return error("address and recovery_email are required");
  }

  // Parse address
  const parts = address.split("@");
  if (parts.length !== 2) return error("Invalid address format");
  const [localPart, domain] = parts;

  // Rate limit: max 3 recovery attempts per address per hour
  const allowed = await checkRateLimit(
    env.DB,
    `recover:${localPart.toLowerCase()}@${domain}`,
    3,
    60 * 60 * 1000
  );
  if (!allowed) {
    return error("Too many recovery attempts. Try again later.", 429);
  }

  const GENERIC_MSG =
    "If the address and recovery email match, a new token will be sent.";
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  // Look up address (include soft-deleted — allow recovery of held addresses)
  const recoveryHash = await hash(recovery_email);
  const addr = await env.DB.prepare(
    "SELECT * FROM addresses WHERE local_part = ? AND domain = ? AND recovery_hash = ?"
  )
    .bind(localPart.toLowerCase(), domain, recoveryHash)
    .first<Address>();

  // Helper to log recovery attempts
  async function logRecovery(addressId: string | null, matched: boolean, failureReason: string | null) {
    try {
      await env.DB.prepare(
        `INSERT INTO recovery_log (id, address_id, local_part, domain, recovery_hash_matched, failure_reason, ip_address)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(generateId(), addressId, localPart.toLowerCase(), domain, matched ? 1 : 0, failureReason, ip)
        .run();
    } catch (e) {
      console.error("Failed to log recovery attempt:", e);
    }
  }

  // Always return same response (prevent enumeration)
  if (!addr) {
    // Check if address exists at all (for audit log context)
    const anyAddr = await env.DB.prepare(
      "SELECT id FROM addresses WHERE local_part = ? AND domain = ?"
    )
      .bind(localPart.toLowerCase(), domain)
      .first<{ id: string }>();

    await logRecovery(
      anyAddr?.id || null,
      false,
      anyAddr ? "recovery_email_mismatch" : "address_not_found"
    );
    return json({ message: GENERIC_MSG });
  }

  if (!env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY not configured — cannot send recovery email");
    await logRecovery(addr.id, true, "resend_not_configured");
    return error("Recovery service temporarily unavailable", 503);
  }

  // Generate new token
  const newToken = generateToken();
  const newTokenHash = await hash(newToken);

  // Send recovery email BEFORE updating token — if send fails, old token stays valid
  const emailBody = `Your ShellMail token has been reset.

Address: ${localPart}@${domain}
New Token: ${newToken}

Save this token — it will not be shown again.
If you did not request this, your token has been changed. Contact support.

— ShellMail (shellmail.ai)`;

  const result = await sendViaResend(env.RESEND_API_KEY, {
    from: `ShellMail <noreply@${env.DOMAIN}>`,
    to: recovery_email,
    subject: `ShellMail Token Recovery — ${localPart}@${domain}`,
    text: emailBody,
  });

  if (!result.success) {
    console.error("Recovery email send failed:", result.error);
    await logRecovery(addr.id, true, `resend_send_failed: ${result.error}`);
    return error("Failed to send recovery email. Please try again later.", 500);
  }

  // Email sent successfully — now commit the token change
  // If the address was soft-deleted, reactivate it
  await env.DB.prepare(
    "UPDATE addresses SET token_hash = ?, deleted_at = NULL, held_until = NULL, status = 'active' WHERE id = ?"
  )
    .bind(newTokenHash, addr.id)
    .run();

  await logRecovery(addr.id, true, null);
  return json({ message: GENERIC_MSG });
}

/** GET /api/mail — list emails for the authenticated address */
async function listMail(request: Request, env: Env): Promise<Response> {
  const addr = await authenticate(request, env.DB);
  if (addr instanceof Response) return addr;

  const url = new URL(request.url);
  const unreadOnly = url.searchParams.get("unread") === "true";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 100);
  const offset = parseInt(url.searchParams.get("offset") || "0");

  let query = "SELECT id, from_addr, from_name, subject, received_at, is_read, is_archived, expires_at, message_id, thread_id, in_reply_to, references_header FROM emails WHERE address_id = ?";
  const params: unknown[] = [addr.id];

  if (unreadOnly) {
    query += " AND is_read = 0";
  }

  query += " AND is_archived = 0 ORDER BY received_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const results = await env.DB.prepare(query)
    .bind(...params)
    .all<Omit<Email, "body_text" | "body_html" | "address_id">>();

  // Get total unread count
  const unread = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM emails WHERE address_id = ? AND is_read = 0 AND is_archived = 0"
  )
    .bind(addr.id)
    .first<{ count: number }>();

  return json({
    address: `${addr.local_part}@${addr.domain}`,
    unread_count: unread?.count || 0,
    emails: results.results,
  });
}

/** GET /api/mail/:id — get full email */
async function getMail(
  request: Request,
  env: Env,
  emailId: string
): Promise<Response> {
  const addr = await authenticate(request, env.DB);
  if (addr instanceof Response) return addr;

  const email = await env.DB.prepare(
    "SELECT * FROM emails WHERE id = ? AND address_id = ?"
  )
    .bind(emailId, addr.id)
    .first<Email>();

  if (!email) return error("Email not found", 404);

  return json({
    id: email.id,
    from_addr: email.from_addr,
    from_name: email.from_name,
    subject: email.subject,
    body_text: email.body_text,
    body_html: email.body_html,
    received_at: email.received_at,
    is_read: email.is_read,
    is_archived: email.is_archived,
    expires_at: email.expires_at,
    message_id: email.message_id,
    thread_id: email.thread_id,
    in_reply_to: email.in_reply_to,
    references_header: email.references_header,
  });
}

/** PATCH /api/mail/:id — update email (mark read/unread, archive) */
async function updateMail(
  request: Request,
  env: Env,
  emailId: string
): Promise<Response> {
  const addr = await authenticate(request, env.DB);
  if (addr instanceof Response) return addr;

  let body: { is_read?: boolean; is_archived?: boolean };
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON body");
  }

  // Verify email belongs to this address
  const existing = await env.DB.prepare(
    "SELECT id FROM emails WHERE id = ? AND address_id = ?"
  )
    .bind(emailId, addr.id)
    .first();

  if (!existing) return error("Email not found", 404);

  const updates: string[] = [];
  const params: unknown[] = [];

  if (body.is_read !== undefined) {
    updates.push("is_read = ?");
    params.push(body.is_read ? 1 : 0);
  }
  if (body.is_archived !== undefined) {
    updates.push("is_archived = ?");
    params.push(body.is_archived ? 1 : 0);
  }

  if (updates.length === 0) return error("No updates provided");

  params.push(emailId);
  await env.DB.prepare(
    `UPDATE emails SET ${updates.join(", ")} WHERE id = ?`
  )
    .bind(...params)
    .run();

  return json({ ok: true });
}

/** DELETE /api/mail/:id — delete email */
async function deleteMail(
  request: Request,
  env: Env,
  emailId: string
): Promise<Response> {
  const addr = await authenticate(request, env.DB);
  if (addr instanceof Response) return addr;

  const result = await env.DB.prepare(
    "DELETE FROM emails WHERE id = ? AND address_id = ?"
  )
    .bind(emailId, addr.id)
    .run();

  if (!result.meta.changes) return error("Email not found", 404);
  return json({ ok: true });
}

/** POST /api/mail/send — send an email */
async function sendMail(request: Request, env: Env): Promise<Response> {
  const addr = await authenticate(request, env.DB);
  if (addr instanceof Response) return addr;

  if (!env.RESEND_API_KEY) {
    return error("Email sending not configured", 503);
  }

  let body: SendEmailRequest;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON body");
  }

  // Validate required fields
  if (!body.to || !validateEmail(body.to)) {
    return error("Valid 'to' email address required");
  }
  if (!body.subject) {
    return error("'subject' is required");
  }
  if (!body.body_text) {
    return error("'body_text' is required");
  }

  // Check rate limit
  const limit = getSendLimit(addr.plan || "free");
  const allowed = await checkRateLimit(
    env.DB,
    `send:${addr.id}`,
    limit,
    24 * 60 * 60 * 1000 // 24 hours
  );
  if (!allowed) {
    return error(`Daily send limit reached (${limit}/day for ${addr.plan || "free"} plan)`, 429);
  }

  // Handle reply threading
  let replyHeaders: Record<string, string> | undefined;
  let threadId: string | null = null;

  if (body.reply_to_id) {
    const original = await env.DB.prepare(
      "SELECT from_addr, message_id, thread_id, references_header FROM emails WHERE id = ? AND address_id = ?"
    )
      .bind(body.reply_to_id, addr.id)
      .first<{ from_addr: string; message_id: string | null; thread_id: string | null; references_header: string | null }>();

    if (!original) {
      return error("reply_to_id not found", 404);
    }

    // Use existing thread_id or start one from the original message_id
    threadId = original.thread_id || original.message_id;

    if (original.message_id) {
      // Build References header: existing references + original message_id
      const existingRefs = original.references_header || "";
      const allRefs = existingRefs ? `${existingRefs} ${original.message_id}` : original.message_id;

      replyHeaders = {
        "In-Reply-To": original.message_id,
        "References": allRefs,
      };
    }
  }

  // Generate Message-ID for this email
  const messageId = generateMessageId(addr.domain);

  // Send via Resend
  const fromAddr = `${addr.local_part}@${addr.domain}`;
  const result = await sendViaResend(env.RESEND_API_KEY, {
    from: fromAddr,
    to: body.to,
    subject: body.subject,
    text: body.body_text,
    html: body.body_html,
    headers: {
      "Message-ID": messageId,
      ...replyHeaders,
    },
  });

  if (!result.success) {
    return error(result.error || "Failed to send email", 500);
  }

  // Store sent email
  const emailId = generateId();
  // If no threadId yet, use this message's ID as the thread
  const finalThreadId = threadId || messageId;

  await env.DB.prepare(
    `INSERT INTO emails (id, address_id, from_addr, to_addr, subject, body_text, body_html, direction, message_id, thread_id, in_reply_to, references_header)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'outbound', ?, ?, ?, ?)`
  )
    .bind(
      emailId,
      addr.id,
      fromAddr,
      body.to,
      body.subject,
      body.body_text,
      body.body_html || null,
      messageId,
      finalThreadId,
      replyHeaders?.["In-Reply-To"] || null,
      replyHeaders?.["References"] || null
    )
    .run();

  // Update sent count
  await env.DB.prepare(
    "UPDATE addresses SET messages_sent = messages_sent + 1 WHERE id = ?"
  )
    .bind(addr.id)
    .run();

  return json({
    ok: true,
    id: emailId,
    message_id: messageId,
  }, 201);
}

/** GET /api/mail/sent — list sent emails */
async function getSentMail(request: Request, env: Env): Promise<Response> {
  const addr = await authenticate(request, env.DB);
  if (addr instanceof Response) return addr;

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 100);
  const offset = parseInt(url.searchParams.get("offset") || "0");

  const results = await env.DB.prepare(
    `SELECT id, to_addr, subject, received_at, message_id
     FROM emails
     WHERE address_id = ? AND direction = 'outbound'
     ORDER BY received_at DESC
     LIMIT ? OFFSET ?`
  )
    .bind(addr.id, limit, offset)
    .all<{ id: string; to_addr: string; subject: string; received_at: string; message_id: string }>();

  return json({
    address: `${addr.local_part}@${addr.domain}`,
    sent_count: addr.messages_sent || 0,
    emails: results.results,
  });
}

/** GET /api/mail/otp — get latest OTP with optional long-poll wait */
async function getOtp(request: Request, env: Env): Promise<Response> {
  const addr = await authenticate(request, env.DB);
  if (addr instanceof Response) return addr;

  const url = new URL(request.url);
  const timeout = Math.min(parseInt(url.searchParams.get("timeout") || "0"), 30000); // Max 30s
  const since = url.searchParams.get("since"); // ISO timestamp to only get newer emails
  const from = url.searchParams.get("from"); // Filter by sender domain/address

  const startTime = Date.now();

  // Poll loop
  while (true) {
    let query = `
      SELECT id, from_addr, subject, otp_code, otp_link, received_at
      FROM emails
      WHERE address_id = ? AND otp_extracted = 1
    `;
    const params: unknown[] = [addr.id];

    if (since) {
      query += " AND received_at > ?";
      params.push(since);
    }

    if (from) {
      query += " AND from_addr LIKE ?";
      params.push(`%${from}%`);
    }

    query += " ORDER BY received_at DESC LIMIT 1";

    const email = await env.DB.prepare(query)
      .bind(...params)
      .first<{
        id: string;
        from_addr: string;
        subject: string;
        otp_code: string | null;
        otp_link: string | null;
        received_at: string;
      }>();

    if (email) {
      return json({
        found: true,
        email_id: email.id,
        from: email.from_addr,
        subject: email.subject,
        code: email.otp_code,
        link: email.otp_link,
        received_at: email.received_at,
      });
    }

    // Check if we should keep waiting
    const elapsed = Date.now() - startTime;
    if (timeout === 0 || elapsed >= timeout) {
      return json({
        found: false,
        message: timeout > 0 ? "Timeout waiting for OTP" : "No OTP found",
      });
    }

    // Wait 1 second before polling again
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

/** GET /api/mail/threads — list email threads */
async function listThreads(request: Request, env: Env): Promise<Response> {
  const addr = await authenticate(request, env.DB);
  if (addr instanceof Response) return addr;

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 100);
  const offset = parseInt(url.searchParams.get("offset") || "0");

  // Get latest email per thread
  const threads = await env.DB.prepare(`
    SELECT
      thread_id,
      MAX(received_at) as last_message_at,
      COUNT(*) as message_count,
      SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) as unread_count
    FROM emails
    WHERE address_id = ? AND thread_id IS NOT NULL AND is_archived = 0
    GROUP BY thread_id
    ORDER BY last_message_at DESC
    LIMIT ? OFFSET ?
  `)
    .bind(addr.id, limit, offset)
    .all<{
      thread_id: string;
      last_message_at: string;
      message_count: number;
      unread_count: number;
    }>();

  // Get preview for each thread (latest message)
  const threadPreviews = await Promise.all(
    (threads.results || []).map(async (t) => {
      const latest = await env.DB.prepare(`
        SELECT id, from_addr, from_name, to_addr, subject, direction, received_at
        FROM emails
        WHERE address_id = ? AND thread_id = ?
        ORDER BY received_at DESC
        LIMIT 1
      `)
        .bind(addr.id, t.thread_id)
        .first<{
          id: string;
          from_addr: string;
          from_name: string | null;
          to_addr: string | null;
          subject: string;
          direction: string;
          received_at: string;
        }>();

      return {
        thread_id: t.thread_id,
        subject: latest?.subject || "(no subject)",
        last_message: {
          id: latest?.id,
          from_addr: latest?.from_addr,
          from_name: latest?.from_name,
          to_addr: latest?.to_addr,
          direction: latest?.direction,
          received_at: latest?.received_at,
        },
        message_count: t.message_count,
        unread_count: t.unread_count,
        last_message_at: t.last_message_at,
      };
    })
  );

  return json({
    threads: threadPreviews,
    count: threadPreviews.length,
  });
}

/** GET /api/mail/threads/:id — get all emails in a thread */
async function getThread(
  request: Request,
  env: Env,
  threadId: string
): Promise<Response> {
  const addr = await authenticate(request, env.DB);
  if (addr instanceof Response) return addr;

  const emails = await env.DB.prepare(`
    SELECT id, from_addr, from_name, to_addr, subject, body_text, body_html,
           direction, received_at, is_read, message_id
    FROM emails
    WHERE address_id = ? AND thread_id = ?
    ORDER BY received_at ASC
  `)
    .bind(addr.id, threadId)
    .all<{
      id: string;
      from_addr: string;
      from_name: string | null;
      to_addr: string | null;
      subject: string;
      body_text: string | null;
      body_html: string | null;
      direction: string;
      received_at: string;
      is_read: number;
      message_id: string | null;
    }>();

  if (!emails.results?.length) {
    return error("Thread not found", 404);
  }

  // Mark all as read
  await env.DB.prepare(
    "UPDATE emails SET is_read = 1 WHERE address_id = ? AND thread_id = ?"
  )
    .bind(addr.id, threadId)
    .run();

  return json({
    thread_id: threadId,
    subject: emails.results[0]?.subject || "(no subject)",
    messages: emails.results.map((e) => ({
      id: e.id,
      from_addr: e.from_addr,
      from_name: e.from_name,
      to_addr: e.to_addr,
      subject: e.subject,
      body_text: e.body_text,
      body_html: e.body_html,
      direction: e.direction,
      received_at: e.received_at,
      is_read: !!e.is_read,
      message_id: e.message_id,
    })),
    message_count: emails.results.length,
  });
}

/** GET /api/mail/search — search emails by query */
async function searchMail(request: Request, env: Env): Promise<Response> {
  const addr = await authenticate(request, env.DB);
  if (addr instanceof Response) return addr;

  const url = new URL(request.url);
  const q = url.searchParams.get("q") || "";
  const from = url.searchParams.get("from");
  const hasOtp = url.searchParams.get("has_otp");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 100);

  if (!q && !from && hasOtp === null) {
    return error("At least one search parameter required: q, from, or has_otp");
  }

  let query = `
    SELECT id, from_addr, from_name, subject, received_at, is_read, otp_code, otp_link, expires_at
    FROM emails
    WHERE address_id = ? AND is_archived = 0
  `;
  const params: unknown[] = [addr.id];

  if (q) {
    query += " AND (subject LIKE ? OR body_text LIKE ? OR from_addr LIKE ?)";
    const searchTerm = `%${q}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }

  if (from) {
    query += " AND from_addr LIKE ?";
    params.push(`%${from}%`);
  }

  if (hasOtp === "true") {
    query += " AND otp_extracted = 1";
  }

  query += " ORDER BY received_at DESC LIMIT ?";
  params.push(limit);

  const results = await env.DB.prepare(query)
    .bind(...params)
    .all<{
      id: string;
      from_addr: string;
      from_name: string | null;
      subject: string;
      received_at: string;
      is_read: number;
      otp_code: string | null;
      otp_link: string | null;
      expires_at: string | null;
    }>();

  return json({
    count: results.results?.length || 0,
    emails: results.results?.map(e => ({
      id: e.id,
      from_addr: e.from_addr,
      from_name: e.from_name,
      subject: e.subject,
      received_at: e.received_at,
      is_read: !!e.is_read,
      otp_code: e.otp_code,
      otp_link: e.otp_link,
      expires_at: e.expires_at,
    })) || [],
  });
}

/** GET /api/webhook — get webhook configuration */
async function getWebhook(request: Request, env: Env): Promise<Response> {
  const addr = await authenticate(request, env.DB);
  if (addr instanceof Response) return addr;

  return json({
    configured: !!addr.webhook_url,
    url: addr.webhook_url || null,
    has_secret: !!addr.webhook_secret,
  });
}

/** PUT /api/webhook — configure webhook */
async function setWebhook(request: Request, env: Env): Promise<Response> {
  const addr = await authenticate(request, env.DB);
  if (addr instanceof Response) return addr;

  let body: WebhookConfig;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON body");
  }

  const { url, secret } = body;

  // Validate URL
  if (!url) {
    return error("url is required");
  }

  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return error("url must be http or https");
    }
  } catch {
    return error("Invalid url format");
  }

  // Generate secret if not provided
  const webhookSecret = secret || generateToken().replace("sm_", "whsec_");

  await env.DB.prepare(
    "UPDATE addresses SET webhook_url = ?, webhook_secret = ? WHERE id = ?"
  )
    .bind(url, webhookSecret, addr.id)
    .run();

  return json({
    ok: true,
    url,
    secret: webhookSecret,
    note: "Save this secret — use it to verify webhook signatures.",
  });
}

/** DELETE /api/webhook — remove webhook configuration */
async function deleteWebhook(request: Request, env: Env): Promise<Response> {
  const addr = await authenticate(request, env.DB);
  if (addr instanceof Response) return addr;

  await env.DB.prepare(
    "UPDATE addresses SET webhook_url = NULL, webhook_secret = NULL WHERE id = ?"
  )
    .bind(addr.id)
    .run();

  return json({ ok: true, message: "Webhook configuration removed" });
}

/** DELETE /api/addresses/me — soft-delete address with 14-day hold window */
async function deleteAddress(request: Request, env: Env): Promise<Response> {
  const addr = await authenticate(request, env.DB);
  if (addr instanceof Response) return addr;

  const now = new Date();
  const heldUntil = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

  // Soft-delete: mark as deleted, hold for 14 days so the same owner can reclaim
  await env.DB.prepare(
    "UPDATE addresses SET deleted_at = ?, held_until = ?, status = 'disabled' WHERE id = ?"
  )
    .bind(now.toISOString(), heldUntil, addr.id)
    .run();

  // Clean up emails — they're gone
  await env.DB.prepare("DELETE FROM emails WHERE address_id = ?")
    .bind(addr.id)
    .run();

  return json({
    ok: true,
    deleted: `${addr.local_part}@${addr.domain}`,
    held_until: heldUntil,
    note: "Address held for 14 days. Re-create with the same recovery email to reclaim it.",
  });
}

// ── Router ───────────────────────────────────────────────

function matchRoute(
  method: string,
  pathname: string
): { handler: string; params?: Record<string, string> } | null {
  if (method === "POST" && pathname === "/api/addresses")
    return { handler: "createAddress" };
  if (method === "POST" && pathname === "/api/recover")
    return { handler: "recoverToken" };
  if (method === "GET" && pathname === "/api/mail")
    return { handler: "listMail" };
  if (method === "GET" && pathname === "/api/mail/otp")
    return { handler: "getOtp" };
  if (method === "GET" && pathname === "/api/mail/search")
    return { handler: "searchMail" };
  if (method === "GET" && pathname === "/api/mail/threads")
    return { handler: "listThreads" };
  if (method === "GET" && pathname === "/api/webhook")
    return { handler: "getWebhook" };
  if (method === "PUT" && pathname === "/api/webhook")
    return { handler: "setWebhook" };
  if (method === "DELETE" && pathname === "/api/webhook")
    return { handler: "deleteWebhook" };
  if (method === "DELETE" && pathname === "/api/addresses/me")
    return { handler: "deleteAddress" };
  if (method === "POST" && pathname === "/api/mail/send")
    return { handler: "sendMail" };
  if (method === "GET" && pathname === "/api/mail/sent")
    return { handler: "getSentMail" };

  // /api/mail/threads/:id route (must come before generic /api/mail/:id)
  const threadMatch = pathname.match(/^\/api\/mail\/threads\/([a-f0-9-]+)$/);
  if (threadMatch && method === "GET") {
    return { handler: "getThread", params: { id: threadMatch[1] } };
  }

  // /api/mail/:id routes
  const mailMatch = pathname.match(/^\/api\/mail\/([a-f0-9-]+)$/);
  if (mailMatch) {
    const id = mailMatch[1];
    if (method === "GET") return { handler: "getMail", params: { id } };
    if (method === "PATCH") return { handler: "updateMail", params: { id } };
    if (method === "DELETE")
      return { handler: "deleteMail", params: { id } };
  }

  return null;
}

// ── Main Export ──────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
        },
      });
    }

    const url = new URL(request.url);
    const route = matchRoute(request.method, url.pathname);

    if (!route) {
      // Health check
      if (url.pathname === "/health") {
        return json({ service: "shellmail", status: "ok", domain: env.DOMAIN });
      }
      // Admin stats (protected by secret)
      if (url.pathname === "/api/admin/stats") {
        const secret = url.searchParams.get("secret");
        if (secret !== env.ADMIN_SECRET) {
          return error("Unauthorized", 401);
        }
        const stats = await getStats(env);
        return json(stats);
      }
      // Docs redirect to landing page API section
      if (url.pathname === "/docs") {
        return Response.redirect(new URL("/#api-docs", url.origin).toString(), 302);
      }
      return error("Not found", 404);
    }

    try {
      let response: Response;

      switch (route.handler) {
        case "createAddress":
          response = await createAddress(request, env);
          break;
        case "recoverToken":
          response = await recoverToken(request, env);
          break;
        case "listMail":
          response = await listMail(request, env);
          break;
        case "getOtp":
          response = await getOtp(request, env);
          break;
        case "searchMail":
          response = await searchMail(request, env);
          break;
        case "listThreads":
          response = await listThreads(request, env);
          break;
        case "getThread":
          response = await getThread(request, env, route.params!.id);
          break;
        case "getWebhook":
          response = await getWebhook(request, env);
          break;
        case "setWebhook":
          response = await setWebhook(request, env);
          break;
        case "deleteWebhook":
          response = await deleteWebhook(request, env);
          break;
        case "getMail":
          response = await getMail(request, env, route.params!.id);
          break;
        case "updateMail":
          response = await updateMail(request, env, route.params!.id);
          break;
        case "deleteMail":
          response = await deleteMail(request, env, route.params!.id);
          break;
        case "deleteAddress":
          response = await deleteAddress(request, env);
          break;
        case "sendMail":
          response = await sendMail(request, env);
          break;
        case "getSentMail":
          response = await getSentMail(request, env);
          break;
        default:
          response = error("Not found", 404);
      }

      // Add CORS headers
      const headers = new Headers(response.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(response.body, {
        status: response.status,
        headers,
      });
    } catch (e) {
      console.error("Unhandled error:", e);
      return error("Internal server error", 500);
    }
  },
} satisfies ExportedHandler<Env>;
