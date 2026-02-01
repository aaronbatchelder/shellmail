/**
 * ClawMail — API Worker
 * REST API for managing email addresses and reading inbound mail
 */

import { Env, Address, Email, CreateAddressRequest, RecoverRequest } from "./types";
import {
  generateToken,
  generateId,
  hash,
  extractToken,
  validateLocalPart,
  validateEmail,
} from "./auth";

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
    .prepare("SELECT * FROM addresses WHERE token_hash = ?")
    .bind(tokenHash)
    .first<Address>();

  if (!addr) return error("Invalid token", 401);
  return addr;
}

// ── Routes ───────────────────────────────────────────────

/** POST /api/addresses — create a new email address */
async function createAddress(request: Request, env: Env): Promise<Response> {
  let body: CreateAddressRequest;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON body");
  }

  const { local, recovery_email } = body;

  // Validate local part
  const localError = validateLocalPart(local);
  if (localError) return error(localError);

  // Validate recovery email
  if (!recovery_email || !validateEmail(recovery_email)) {
    return error("Valid recovery_email is required");
  }

  // Check availability
  const existing = await env.DB.prepare(
    "SELECT id FROM addresses WHERE local_part = ? AND domain = ?"
  )
    .bind(local.toLowerCase(), env.DOMAIN)
    .first();

  if (existing) return error(`${local}@${env.DOMAIN} is already taken`, 409);

  // Generate token and IDs
  const id = generateId();
  const token = generateToken();
  const tokenHash = await hash(token);
  const recoveryHash = await hash(recovery_email);

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

  // Look up address
  const recoveryHash = await hash(recovery_email);
  const addr = await env.DB.prepare(
    "SELECT * FROM addresses WHERE local_part = ? AND domain = ? AND recovery_hash = ?"
  )
    .bind(localPart.toLowerCase(), domain, recoveryHash)
    .first<Address>();

  // Always return success (prevent enumeration)
  if (!addr) {
    return json({
      message: "If the address and recovery email match, a new token will be sent.",
    });
  }

  // Generate new token and update
  const newToken = generateToken();
  const newTokenHash = await hash(newToken);

  await env.DB.prepare("UPDATE addresses SET token_hash = ? WHERE id = ?")
    .bind(newTokenHash, addr.id)
    .run();

  // TODO: Actually send the recovery email via an email service
  // For MVP, we'll return the token directly (change this before production!)
  return json({
    message: "If the address and recovery email match, a new token will be sent.",
    // TEMPORARY for MVP testing — remove before production
    _dev_token: newToken,
  });
}

/** GET /api/mail — list emails for the authenticated address */
async function listMail(request: Request, env: Env): Promise<Response> {
  const addr = await authenticate(request, env.DB);
  if (addr instanceof Response) return addr;

  const url = new URL(request.url);
  const unreadOnly = url.searchParams.get("unread") === "true";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 100);
  const offset = parseInt(url.searchParams.get("offset") || "0");

  let query = "SELECT id, from_addr, from_name, subject, received_at, is_read, is_archived FROM emails WHERE address_id = ?";
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

/** DELETE /api/addresses/me — delete address and all mail */
async function deleteAddress(request: Request, env: Env): Promise<Response> {
  const addr = await authenticate(request, env.DB);
  if (addr instanceof Response) return addr;

  // Cascade delete handles emails
  await env.DB.prepare("DELETE FROM addresses WHERE id = ?")
    .bind(addr.id)
    .run();

  return json({ ok: true, deleted: `${addr.local_part}@${addr.domain}` });
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
  if (method === "DELETE" && pathname === "/api/addresses/me")
    return { handler: "deleteAddress" };

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
        return json({ service: "clawmail", status: "ok", domain: env.DOMAIN });
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
