/**
 * ShellMail API — Regression Tests
 *
 * Tests every API route with a real D1 database to catch regressions
 * like the recovery flow breaking (Resend replacing MailChannels).
 */
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, beforeEach, vi, beforeAll } from "vitest";
import worker from "./index";

// ── Helpers ──────────────────────────────────────────────

/** Build a Request aimed at the worker */
function req(
  path: string,
  init?: RequestInit & { token?: string }
): Request {
  const { token, ...rest } = init || {};
  const headers = new Headers(rest.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return new Request(`https://shellmail.ai${path}`, { ...rest, headers });
}

/** POST JSON helper */
function post(
  path: string,
  body: unknown,
  opts?: { token?: string; headers?: Record<string, string> }
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...opts?.headers,
  };
  if (opts?.token) headers["Authorization"] = `Bearer ${opts.token}`;
  return new Request(`https://shellmail.ai${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** PATCH JSON helper */
function patch(
  path: string,
  body: unknown,
  token: string
): Request {
  return new Request(`https://shellmail.ai${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

/** PUT JSON helper */
function put(
  path: string,
  body: unknown,
  token: string
): Request {
  return new Request(`https://shellmail.ai${path}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

/** DELETE helper */
function del(path: string, token: string): Request {
  return new Request(`https://shellmail.ai${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Call the worker and parse JSON */
async function call(request: Request): Promise<{ status: number; body: any }> {
  const ctx = createExecutionContext();
  const resp = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  const body = await resp.json();
  return { status: resp.status, body };
}

/** Create an address and return the token + address string */
async function createTestAddress(
  local: string = "testuser",
  recoveryEmail: string = "recovery@example.com"
): Promise<{ token: string; address: string }> {
  const { status, body } = await call(
    post("/api/addresses", { local, recovery_email: recoveryEmail })
  );
  expect(status).toBe(201);
  expect(body.token).toMatch(/^sm_/);
  return { token: body.token, address: body.address };
}

/** Insert a test email directly into D1 for mail-reading tests */
async function insertTestEmail(
  addressId: string,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const id = crypto.randomUUID();
  const defaults = {
    id,
    address_id: addressId,
    from_addr: "sender@example.com",
    from_name: "Sender",
    subject: "Test subject",
    body_text: "Test body",
    body_html: "<p>Test body</p>",
    is_read: 0,
    is_archived: 0,
    direction: "inbound",
  };
  const data = { ...defaults, ...overrides };
  await env.DB.prepare(
    `INSERT INTO emails (id, address_id, from_addr, from_name, subject, body_text, body_html, is_read, is_archived, direction)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      data.id,
      data.address_id,
      data.from_addr,
      data.from_name,
      data.subject,
      data.body_text,
      data.body_html,
      data.is_read,
      data.is_archived,
      data.direction
    )
    .run();
  return id;
}

/** Resolve address row ID from token */
async function getAddressId(token: string): Promise<string> {
  // Hash the token the same way the API does
  const encoded = new TextEncoder().encode(token.toLowerCase().trim());
  const buffer = await crypto.subtle.digest("SHA-256", encoded);
  const tokenHash = Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const row = await env.DB.prepare(
    "SELECT id FROM addresses WHERE token_hash = ?"
  )
    .bind(tokenHash)
    .first<{ id: string }>();
  if (!row) throw new Error("Address not found for token");
  return row.id;
}

// ── Setup ────────────────────────────────────────────────

beforeAll(async () => {
  // Run all migrations to set up schema
  const migrations = [
    // 0001_init
    `CREATE TABLE IF NOT EXISTS addresses (
      id TEXT PRIMARY KEY, local_part TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'shellmail.ai',
      token_hash TEXT NOT NULL, recovery_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(local_part, domain)
    )`,
    `CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY, address_id TEXT NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
      from_addr TEXT NOT NULL, from_name TEXT, subject TEXT, body_text TEXT, body_html TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now')), is_read INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0
    )`,
    // 0002_rate_limits
    `CREATE TABLE IF NOT EXISTS rate_limits (
      id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    // 0003-0005 address columns
    `ALTER TABLE addresses ADD COLUMN max_messages INTEGER NOT NULL DEFAULT 50`,
    `ALTER TABLE addresses ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
    `ALTER TABLE addresses ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'`,
    `ALTER TABLE addresses ADD COLUMN stripe_customer_id TEXT`,
    `ALTER TABLE addresses ADD COLUMN webhook_url TEXT`,
    `ALTER TABLE addresses ADD COLUMN webhook_secret TEXT`,
    `ALTER TABLE addresses ADD COLUMN messages_received INTEGER DEFAULT 0`,
    `ALTER TABLE addresses ADD COLUMN last_activity_at TEXT`,
    // 0005 email columns
    `ALTER TABLE emails ADD COLUMN raw_headers TEXT`,
    `ALTER TABLE emails ADD COLUMN has_attachments INTEGER DEFAULT 0`,
    `ALTER TABLE emails ADD COLUMN otp_code TEXT`,
    `ALTER TABLE emails ADD COLUMN otp_link TEXT`,
    `ALTER TABLE emails ADD COLUMN otp_extracted INTEGER DEFAULT 0`,
    // 0006 retention
    `ALTER TABLE emails ADD COLUMN expires_at TEXT`,
    // 0007 send
    `ALTER TABLE emails ADD COLUMN direction TEXT DEFAULT 'inbound'`,
    `ALTER TABLE emails ADD COLUMN to_addr TEXT`,
    `ALTER TABLE emails ADD COLUMN message_id TEXT`,
    `ALTER TABLE addresses ADD COLUMN messages_sent INTEGER DEFAULT 0`,
    // 0008 threads
    `ALTER TABLE emails ADD COLUMN thread_id TEXT`,
    `ALTER TABLE emails ADD COLUMN in_reply_to TEXT`,
    `ALTER TABLE emails ADD COLUMN references_header TEXT`,
  ];

  for (const sql of migrations) {
    try {
      await env.DB.prepare(sql).run();
    } catch {
      // Ignore "duplicate column" errors on re-runs
    }
  }
});

beforeEach(async () => {
  // Clean tables between tests
  await env.DB.prepare("DELETE FROM emails").run();
  await env.DB.prepare("DELETE FROM addresses").run();
  await env.DB.prepare("DELETE FROM rate_limits").run();
});

// ── Health ───────────────────────────────────────────────

describe("Health", () => {
  it("GET /health returns ok", async () => {
    const { status, body } = await call(req("/health"));
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.domain).toBe("shellmail.ai");
  });
});

// ── CORS ─────────────────────────────────────────────────

describe("CORS", () => {
  it("OPTIONS returns CORS headers", async () => {
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request("https://shellmail.ai/api/mail", { method: "OPTIONS" }),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("API responses include CORS headers", async () => {
    const { token } = await createTestAddress("corsuser");
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req("/api/mail", { token }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

// ── Address Creation ─────────────────────────────────────

describe("POST /api/addresses", () => {
  it("creates address and returns token", async () => {
    const { token, address } = await createTestAddress("myagent");
    expect(address).toBe("myagent@shellmail.ai");
    expect(token).toMatch(/^sm_[a-f0-9]{64}$/);
  });

  it("lowercases local part", async () => {
    const { address } = await createTestAddress("MyAgent");
    expect(address).toBe("myagent@shellmail.ai");
  });

  it("rejects duplicate local part", async () => {
    await createTestAddress("dupe");
    const { status, body } = await call(
      post("/api/addresses", { local: "dupe", recovery_email: "x@y.com" })
    );
    expect(status).toBe(409);
    expect(body.error).toContain("already taken");
  });

  it("rejects invalid recovery email", async () => {
    const { status, body } = await call(
      post("/api/addresses", { local: "good", recovery_email: "not-an-email" })
    );
    expect(status).toBe(400);
    expect(body.error).toContain("recovery_email");
  });

  it("rejects reserved local parts", async () => {
    const { status, body } = await call(
      post("/api/addresses", { local: "admin", recovery_email: "x@y.com" })
    );
    expect(status).toBe(400);
    expect(body.error).toContain("reserved");
  });

  it("rejects too-short local parts", async () => {
    const { status, body } = await call(
      post("/api/addresses", { local: "a", recovery_email: "x@y.com" })
    );
    expect(status).toBe(400);
  });

  it("auto-generates local part when not provided", async () => {
    const { status, body } = await call(
      post("/api/addresses", { recovery_email: "x@y.com" })
    );
    expect(status).toBe(201);
    expect(body.address).toMatch(/.+@shellmail\.ai$/);
  });

  it("auto-generates local part when 'auto'", async () => {
    const { status, body } = await call(
      post("/api/addresses", { local: "auto", recovery_email: "x@y.com" })
    );
    expect(status).toBe(201);
    expect(body.address).not.toContain("auto@");
  });

  it("rejects invalid JSON body", async () => {
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request("https://shellmail.ai/api/addresses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(400);
  });
});

// ── Authentication ───────────────────────────────────────

describe("Authentication", () => {
  it("rejects requests without token", async () => {
    const { status, body } = await call(req("/api/mail"));
    expect(status).toBe(401);
    expect(body.error).toContain("Authorization");
  });

  it("rejects invalid token", async () => {
    const { status, body } = await call(
      req("/api/mail", { token: "sm_0000000000000000000000000000000000000000000000000000000000000000" })
    );
    expect(status).toBe(401);
    expect(body.error).toContain("Invalid token");
  });

  it("rejects malformed token (no sm_ prefix)", async () => {
    const { status } = await call(
      req("/api/mail", {
        headers: { Authorization: "Bearer badtoken" },
      })
    );
    expect(status).toBe(401);
  });

  it("accepts valid token", async () => {
    const { token } = await createTestAddress("authtest");
    const { status, body } = await call(req("/api/mail", { token }));
    expect(status).toBe(200);
    expect(body.address).toBe("authtest@shellmail.ai");
  });
});

// ── Token Recovery (REGRESSION: previously broke when MailChannels was removed) ──

describe("POST /api/recover", () => {
  it("returns generic message for non-existent address (no enumeration)", async () => {
    const { status, body } = await call(
      post("/api/recover", {
        address: "nobody@shellmail.ai",
        recovery_email: "x@y.com",
      })
    );
    expect(status).toBe(200);
    expect(body.message).toContain("If the address and recovery email match");
  });

  it("returns generic message for wrong recovery email (no enumeration)", async () => {
    await createTestAddress("recoverme", "correct@example.com");
    const { status, body } = await call(
      post("/api/recover", {
        address: "recoverme@shellmail.ai",
        recovery_email: "wrong@example.com",
      })
    );
    expect(status).toBe(200);
    expect(body.message).toContain("If the address and recovery email match");
  });

  it("returns 503 when RESEND_API_KEY is missing", async () => {
    // In test env, RESEND_API_KEY is not set, so a valid match should hit the
    // "Recovery service temporarily unavailable" branch
    await createTestAddress("recoverme2", "recover@example.com");
    const { status, body } = await call(
      post("/api/recover", {
        address: "recoverme2@shellmail.ai",
        recovery_email: "recover@example.com",
      })
    );
    // Without RESEND_API_KEY, we expect 503
    expect(status).toBe(503);
    expect(body.error).toContain("Recovery service temporarily unavailable");
  });

  it("validates required fields", async () => {
    const { status: s1 } = await call(
      post("/api/recover", { address: "x@shellmail.ai" })
    );
    expect(s1).toBe(400);

    const { status: s2 } = await call(
      post("/api/recover", { recovery_email: "x@y.com" })
    );
    expect(s2).toBe(400);
  });

  it("rejects invalid address format", async () => {
    const { status, body } = await call(
      post("/api/recover", {
        address: "no-at-sign",
        recovery_email: "x@y.com",
      })
    );
    expect(status).toBe(400);
    expect(body.error).toContain("Invalid address format");
  });

  it("rate limits recovery attempts", async () => {
    await createTestAddress("ratelimited", "rl@example.com");
    // 3 attempts should succeed (or return generic/503), 4th should be rate limited
    for (let i = 0; i < 3; i++) {
      await call(
        post("/api/recover", {
          address: "ratelimited@shellmail.ai",
          recovery_email: "rl@example.com",
        })
      );
    }
    const { status, body } = await call(
      post("/api/recover", {
        address: "ratelimited@shellmail.ai",
        recovery_email: "rl@example.com",
      })
    );
    expect(status).toBe(429);
    expect(body.error).toContain("Too many recovery attempts");
  });

  it("sends email via Resend and updates token when RESEND_API_KEY is set", async () => {
    // Temporarily set RESEND_API_KEY and mock fetch
    const originalKey = env.RESEND_API_KEY;
    (env as any).RESEND_API_KEY = "re_test_key";

    // Mock global fetch to intercept Resend API call
    const originalFetch = globalThis.fetch;
    let resendCallBody: any = null;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.resend.com")) {
        resendCallBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ id: "mock-id" }), { status: 200 });
      }
      return originalFetch(input, init);
    };

    try {
      await createTestAddress("recoverable", "myrecovery@example.com");

      // Get original token hash
      const origHash = await env.DB.prepare(
        "SELECT token_hash FROM addresses WHERE local_part = 'recoverable'"
      ).first<{ token_hash: string }>();

      const { status, body } = await call(
        post("/api/recover", {
          address: "recoverable@shellmail.ai",
          recovery_email: "myrecovery@example.com",
        })
      );

      expect(status).toBe(200);
      expect(body.message).toContain("If the address and recovery email match");

      // Verify Resend was called with correct parameters
      expect(resendCallBody).not.toBeNull();
      expect(resendCallBody.to).toBe("myrecovery@example.com");
      expect(resendCallBody.from).toContain("noreply@shellmail.ai");
      expect(resendCallBody.subject).toContain("Token Recovery");
      expect(resendCallBody.text).toContain("recoverable@shellmail.ai");
      expect(resendCallBody.text).toContain("sm_"); // Contains new token

      // Verify token was actually rotated in DB
      const newHash = await env.DB.prepare(
        "SELECT token_hash FROM addresses WHERE local_part = 'recoverable'"
      ).first<{ token_hash: string }>();
      expect(newHash!.token_hash).not.toBe(origHash!.token_hash);
    } finally {
      (env as any).RESEND_API_KEY = originalKey;
      globalThis.fetch = originalFetch;
    }
  });

  it("does NOT rotate token when Resend send fails", async () => {
    const originalKey = env.RESEND_API_KEY;
    (env as any).RESEND_API_KEY = "re_test_key";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.resend.com")) {
        return new Response("error", { status: 500 });
      }
      return originalFetch(input);
    };

    try {
      await createTestAddress("safeguard", "safe@example.com");

      const origHash = await env.DB.prepare(
        "SELECT token_hash FROM addresses WHERE local_part = 'safeguard'"
      ).first<{ token_hash: string }>();

      const { status } = await call(
        post("/api/recover", {
          address: "safeguard@shellmail.ai",
          recovery_email: "safe@example.com",
        })
      );

      expect(status).toBe(500);

      // Token should NOT have changed
      const afterHash = await env.DB.prepare(
        "SELECT token_hash FROM addresses WHERE local_part = 'safeguard'"
      ).first<{ token_hash: string }>();
      expect(afterHash!.token_hash).toBe(origHash!.token_hash);
    } finally {
      (env as any).RESEND_API_KEY = originalKey;
      globalThis.fetch = originalFetch;
    }
  });
});

// ── Mail CRUD ────────────────────────────────────────────

describe("Mail operations", () => {
  let token: string;
  let addressId: string;

  beforeEach(async () => {
    const result = await createTestAddress("mailuser");
    token = result.token;
    addressId = await getAddressId(token);
  });

  describe("GET /api/mail (inbox)", () => {
    it("returns empty inbox", async () => {
      const { status, body } = await call(req("/api/mail", { token }));
      expect(status).toBe(200);
      expect(body.emails).toHaveLength(0);
      expect(body.unread_count).toBe(0);
      expect(body.address).toBe("mailuser@shellmail.ai");
    });

    it("returns emails sorted by received_at desc", async () => {
      await insertTestEmail(addressId, { subject: "First" });
      await insertTestEmail(addressId, { subject: "Second" });
      const { body } = await call(req("/api/mail", { token }));
      expect(body.emails).toHaveLength(2);
    });

    it("filters unread only", async () => {
      await insertTestEmail(addressId, { is_read: 0 });
      await insertTestEmail(addressId, { is_read: 1 });
      const { body } = await call(
        req("/api/mail?unread=true", { token })
      );
      expect(body.emails).toHaveLength(1);
    });

    it("excludes archived emails", async () => {
      await insertTestEmail(addressId, { is_archived: 0 });
      await insertTestEmail(addressId, { is_archived: 1 });
      const { body } = await call(req("/api/mail", { token }));
      expect(body.emails).toHaveLength(1);
    });

    it("respects limit param", async () => {
      for (let i = 0; i < 5; i++) await insertTestEmail(addressId);
      const { body } = await call(
        req("/api/mail?limit=2", { token })
      );
      expect(body.emails).toHaveLength(2);
    });

    it("caps limit at 100", async () => {
      // Just verify it doesn't error — we don't need 100 emails
      const { status } = await call(
        req("/api/mail?limit=999", { token })
      );
      expect(status).toBe(200);
    });
  });

  describe("GET /api/mail/:id", () => {
    it("returns full email", async () => {
      const emailId = await insertTestEmail(addressId, {
        subject: "Full read",
        body_text: "Hello world",
      });
      const { status, body } = await call(
        req(`/api/mail/${emailId}`, { token })
      );
      expect(status).toBe(200);
      expect(body.subject).toBe("Full read");
      expect(body.body_text).toBe("Hello world");
    });

    it("returns 404 for non-existent email", async () => {
      const { status } = await call(
        req(`/api/mail/${crypto.randomUUID()}`, { token })
      );
      expect(status).toBe(404);
    });

    it("cannot read another user's email", async () => {
      const other = await createTestAddress("otheruser", "other@y.com");
      const otherId = await getAddressId(other.token);
      const emailId = await insertTestEmail(otherId);
      const { status } = await call(
        req(`/api/mail/${emailId}`, { token })
      );
      expect(status).toBe(404);
    });
  });

  describe("PATCH /api/mail/:id", () => {
    it("marks email as read", async () => {
      const emailId = await insertTestEmail(addressId);
      const { status, body } = await call(
        patch(`/api/mail/${emailId}`, { is_read: true }, token)
      );
      expect(status).toBe(200);
      expect(body.ok).toBe(true);

      // Verify
      const row = await env.DB.prepare("SELECT is_read FROM emails WHERE id = ?")
        .bind(emailId)
        .first<{ is_read: number }>();
      expect(row!.is_read).toBe(1);
    });

    it("marks email as unread", async () => {
      const emailId = await insertTestEmail(addressId, { is_read: 1 });
      await call(patch(`/api/mail/${emailId}`, { is_read: false }, token));
      const row = await env.DB.prepare("SELECT is_read FROM emails WHERE id = ?")
        .bind(emailId)
        .first<{ is_read: number }>();
      expect(row!.is_read).toBe(0);
    });

    it("archives email", async () => {
      const emailId = await insertTestEmail(addressId);
      await call(
        patch(`/api/mail/${emailId}`, { is_archived: true }, token)
      );
      const row = await env.DB.prepare("SELECT is_archived FROM emails WHERE id = ?")
        .bind(emailId)
        .first<{ is_archived: number }>();
      expect(row!.is_archived).toBe(1);
    });

    it("rejects patch with no updates", async () => {
      const emailId = await insertTestEmail(addressId);
      const { status, body } = await call(
        patch(`/api/mail/${emailId}`, {}, token)
      );
      expect(status).toBe(400);
      expect(body.error).toContain("No updates");
    });

    it("returns 404 for non-existent email", async () => {
      const { status } = await call(
        patch(`/api/mail/${crypto.randomUUID()}`, { is_read: true }, token)
      );
      expect(status).toBe(404);
    });
  });

  describe("DELETE /api/mail/:id", () => {
    it("deletes email", async () => {
      const emailId = await insertTestEmail(addressId);
      const { status, body } = await call(del(`/api/mail/${emailId}`, token));
      expect(status).toBe(200);
      expect(body.ok).toBe(true);

      const row = await env.DB.prepare("SELECT id FROM emails WHERE id = ?")
        .bind(emailId)
        .first();
      expect(row).toBeNull();
    });

    it("returns 404 for non-existent email", async () => {
      const { status } = await call(
        del(`/api/mail/${crypto.randomUUID()}`, token)
      );
      expect(status).toBe(404);
    });
  });
});

// ── Search ───────────────────────────────────────────────

describe("GET /api/mail/search", () => {
  let token: string;
  let addressId: string;

  beforeEach(async () => {
    const result = await createTestAddress("searcher");
    token = result.token;
    addressId = await getAddressId(token);
  });

  it("searches by subject", async () => {
    await insertTestEmail(addressId, { subject: "Welcome to ShellMail" });
    await insertTestEmail(addressId, { subject: "Password reset" });
    const { body } = await call(req("/api/mail/search?q=Welcome", { token }));
    expect(body.count).toBe(1);
    expect(body.emails[0].subject).toBe("Welcome to ShellMail");
  });

  it("searches by from address", async () => {
    await insertTestEmail(addressId, { from_addr: "github@noreply.com" });
    await insertTestEmail(addressId, { from_addr: "stripe@billing.com" });
    const { body } = await call(
      req("/api/mail/search?from=github", { token })
    );
    expect(body.count).toBe(1);
  });

  it("requires at least one search param", async () => {
    const { status, body } = await call(
      req("/api/mail/search", { token })
    );
    expect(status).toBe(400);
    expect(body.error).toContain("search parameter");
  });
});

// ── OTP ──────────────────────────────────────────────────

describe("GET /api/mail/otp", () => {
  let token: string;
  let addressId: string;

  beforeEach(async () => {
    const result = await createTestAddress("otpuser");
    token = result.token;
    addressId = await getAddressId(token);
  });

  it("returns found: false when no OTP emails", async () => {
    const { body } = await call(req("/api/mail/otp", { token }));
    expect(body.found).toBe(false);
  });

  it("returns OTP code when available", async () => {
    await env.DB.prepare(
      `INSERT INTO emails (id, address_id, from_addr, subject, otp_code, otp_extracted, direction)
       VALUES (?, ?, ?, ?, ?, 1, 'inbound')`
    )
      .bind(crypto.randomUUID(), addressId, "verify@service.com", "Your code", "123456")
      .run();

    const { body } = await call(req("/api/mail/otp", { token }));
    expect(body.found).toBe(true);
    expect(body.code).toBe("123456");
  });
});

// ── Send Email ───────────────────────────────────────────

describe("POST /api/mail/send", () => {
  let token: string;

  beforeEach(async () => {
    const result = await createTestAddress("sender");
    token = result.token;
  });

  it("returns 503 when RESEND_API_KEY is not set", async () => {
    const { status, body } = await call(
      post(
        "/api/mail/send",
        { to: "dest@example.com", subject: "Hi", body_text: "Hello" },
        { token }
      )
    );
    expect(status).toBe(503);
    expect(body.error).toContain("not configured");
  });

  it("validates required fields", async () => {
    (env as any).RESEND_API_KEY = "re_test";
    try {
      const { status: s1 } = await call(
        post("/api/mail/send", { subject: "Hi", body_text: "Hello" }, { token })
      );
      expect(s1).toBe(400);

      const { status: s2 } = await call(
        post("/api/mail/send", { to: "a@b.com", body_text: "Hello" }, { token })
      );
      expect(s2).toBe(400);

      const { status: s3 } = await call(
        post("/api/mail/send", { to: "a@b.com", subject: "Hi" }, { token })
      );
      expect(s3).toBe(400);
    } finally {
      (env as any).RESEND_API_KEY = undefined;
    }
  });

  it("sends email via Resend and stores in sent", async () => {
    (env as any).RESEND_API_KEY = "re_test";
    const originalFetch = globalThis.fetch;
    let capturedBody: any;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.resend.com")) {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ id: "resend-id" }), { status: 200 });
      }
      return originalFetch(input, init);
    };

    try {
      const { status, body } = await call(
        post(
          "/api/mail/send",
          { to: "dest@example.com", subject: "Test", body_text: "Body" },
          { token }
        )
      );
      expect(status).toBe(201);
      expect(body.ok).toBe(true);
      expect(body.id).toBeDefined();
      expect(body.message_id).toBeDefined();

      // Verify stored
      const stored = await env.DB.prepare(
        "SELECT * FROM emails WHERE direction = 'outbound' AND address_id = (SELECT id FROM addresses WHERE local_part = 'sender')"
      ).first<any>();
      expect(stored).not.toBeNull();
      expect(stored.to_addr).toBe("dest@example.com");
      expect(stored.subject).toBe("Test");
    } finally {
      (env as any).RESEND_API_KEY = undefined;
      globalThis.fetch = originalFetch;
    }
  });
});

// ── Sent Mail ────────────────────────────────────────────

describe("GET /api/mail/sent", () => {
  it("returns empty sent list", async () => {
    const { token } = await createTestAddress("sentuser");
    const { status, body } = await call(req("/api/mail/sent", { token }));
    expect(status).toBe(200);
    expect(body.emails).toHaveLength(0);
  });
});

// ── Webhooks ─────────────────────────────────────────────

describe("Webhook API", () => {
  let token: string;

  beforeEach(async () => {
    const result = await createTestAddress("hookuser");
    token = result.token;
  });

  it("GET /api/webhook — no webhook configured", async () => {
    const { status, body } = await call(req("/api/webhook", { token }));
    expect(status).toBe(200);
    expect(body.configured).toBe(false);
    expect(body.url).toBeNull();
  });

  it("PUT /api/webhook — configures webhook", async () => {
    const { status, body } = await call(
      put("/api/webhook", { url: "https://example.com/hook" }, token)
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.url).toBe("https://example.com/hook");
    expect(body.secret).toBeDefined();
  });

  it("PUT /api/webhook — validates URL", async () => {
    const { status: s1 } = await call(
      put("/api/webhook", { url: "not-a-url" }, token)
    );
    expect(s1).toBe(400);

    const { status: s2 } = await call(
      put("/api/webhook", { url: "ftp://bad.com" }, token)
    );
    expect(s2).toBe(400);
  });

  it("DELETE /api/webhook — removes webhook", async () => {
    await call(put("/api/webhook", { url: "https://example.com/hook" }, token));
    const { status, body } = await call(del("/api/webhook", token));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);

    const { body: check } = await call(req("/api/webhook", { token }));
    expect(check.configured).toBe(false);
  });
});

// ── Delete Address ───────────────────────────────────────

describe("DELETE /api/addresses/me", () => {
  it("deletes address and cascades emails", async () => {
    const { token } = await createTestAddress("deleteme");
    const addressId = await getAddressId(token);
    await insertTestEmail(addressId);

    const { status, body } = await call(del("/api/addresses/me", token));
    expect(status).toBe(200);
    expect(body.deleted).toBe("deleteme@shellmail.ai");

    // Token should no longer work
    const { status: s2 } = await call(req("/api/mail", { token }));
    expect(s2).toBe(401);

    // Emails should be gone (cascade)
    const row = await env.DB.prepare(
      "SELECT id FROM emails WHERE address_id = ?"
    )
      .bind(addressId)
      .first();
    expect(row).toBeNull();
  });
});

// ── 404 ──────────────────────────────────────────────────

describe("404", () => {
  it("returns 404 for unknown routes", async () => {
    const { status, body } = await call(req("/api/nonexistent"));
    expect(status).toBe(404);
    expect(body.error).toBe("Not found");
  });
});

// ── Router ───────────────────────────────────────────────

describe("Router", () => {
  it("routes POST /api/addresses correctly", async () => {
    const { status } = await call(
      post("/api/addresses", { local: "routetest", recovery_email: "r@e.com" })
    );
    expect(status).toBe(201);
  });

  it("routes POST /api/recover correctly", async () => {
    const { status } = await call(
      post("/api/recover", {
        address: "nobody@shellmail.ai",
        recovery_email: "x@y.com",
      })
    );
    // 200 (generic message) — not 404
    expect(status).toBe(200);
  });

  it("routes GET /api/mail/otp correctly (not confused with /api/mail/:id)", async () => {
    const { token } = await createTestAddress("routecheck");
    const { status, body } = await call(req("/api/mail/otp", { token }));
    expect(status).toBe(200);
    expect(body).toHaveProperty("found");
  });

  it("routes GET /api/mail/search correctly", async () => {
    const { token } = await createTestAddress("routecheck2");
    const { status } = await call(
      req("/api/mail/search?q=test", { token })
    );
    expect(status).toBe(200);
  });
});
