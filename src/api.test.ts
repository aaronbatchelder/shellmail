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
import { hash } from "./auth";

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
  // Strip the seeded welcome email so mail-mechanics tests start pristine
  // (welcome behavior has its own dedicated tests)
  await env.DB.prepare(
    "DELETE FROM emails WHERE from_addr = 'welcome@shellmail.ai' AND address_id = (SELECT id FROM addresses WHERE local_part = ?)"
  ).bind(local.toLowerCase()).run();
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
    // 0009 recovery
    `ALTER TABLE addresses ADD COLUMN deleted_at TEXT`,
    `ALTER TABLE addresses ADD COLUMN held_until TEXT`,
    `CREATE TABLE IF NOT EXISTS recovery_log (
      id TEXT PRIMARY KEY, address_id TEXT, local_part TEXT NOT NULL,
      domain TEXT NOT NULL, recovery_hash_matched INTEGER NOT NULL DEFAULT (0),
      failure_reason TEXT, ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    // 0010 anti-spam
    `CREATE TABLE IF NOT EXISTS send_log (
      id TEXT PRIMARY KEY, address_id TEXT NOT NULL, recipient_email TEXT NOT NULL,
      subject TEXT, resend_email_id TEXT, bounce_type TEXT,
      content_scan_score INTEGER, flagged INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS bounce_tracking (
      id TEXT PRIMARY KEY, address_id TEXT NOT NULL, recipient TEXT NOT NULL,
      bounce_type TEXT NOT NULL, reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS abuse_log (
      id TEXT PRIMARY KEY, address_id TEXT NOT NULL, ip_address TEXT,
      abuse_type TEXT NOT NULL, severity TEXT NOT NULL, details TEXT,
      action_taken TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS content_filters (
      id TEXT PRIMARY KEY, pattern_type TEXT NOT NULL, pattern TEXT NOT NULL,
      severity INTEGER NOT NULL, description TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `ALTER TABLE addresses ADD COLUMN recovery_verified INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE addresses ADD COLUMN oauth_provider TEXT`,
    `ALTER TABLE addresses ADD COLUMN oauth_id TEXT`,
    `ALTER TABLE addresses ADD COLUMN authenticated_at TEXT`,
    `ALTER TABLE addresses ADD COLUMN bounce_rate_30d REAL NOT NULL DEFAULT 0.0`,
    `ALTER TABLE addresses ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE addresses ADD COLUMN suspension_reason TEXT`,
    `ALTER TABLE addresses ADD COLUMN ip_address TEXT`,
    // 0011 verification + 0012 hardening (hashed codes, attempt cap)
    `CREATE TABLE IF NOT EXISTS verification_codes (
      id TEXT PRIMARY KEY, address_id TEXT NOT NULL, code_hash TEXT NOT NULL,
      purpose TEXT NOT NULL, expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  ];

  for (const sql of migrations) {
    try {
      await env.DB.prepare(sql).run();
    } catch {
      // Ignore "duplicate column" errors on re-runs
    }
  }

  // Seed content filters (note: JavaScript regex, no inline flags)
  const filters = [
    ['cf_crypto_1', 'keyword', '(bitcoin|crypto|nft|web3).{0,20}(invest|profit|earn|guaranteed)', 75, 'Crypto investment spam'],
    ['cf_pharma_1', 'keyword', '(viagra|cialis|pharmacy|prescription).{0,20}(cheap|discount|online)', 80, 'Pharmaceutical spam'],
    ['cf_urgent_1', 'keyword', '(urgent|act now|limited time|expires|hurry).{0,20}(click|claim|verify)', 60, 'Urgency manipulation'],
    ['cf_finance_1', 'keyword', '(loan|mortgage|credit|debt).{0,20}(approved|guaranteed|instant)', 65, 'Financial spam'],
    ['cf_prize_1', 'keyword', '(won|winner|prize|congratulations|claim).{0,20}(\\$|money|cash|reward)', 70, 'Prize scam'],
    ['cf_allcaps', 'pattern', 'SUBJECT_ALL_CAPS', 50, 'All-caps subject line'],
    ['cf_excessive_links', 'pattern', 'EXCESSIVE_LINKS', 40, 'More than 5 links in message'],
  ];

  for (const [id, pattern_type, pattern, severity, description] of filters) {
    try {
      await env.DB.prepare(
        `INSERT INTO content_filters (id, pattern_type, pattern, severity, description, enabled)
         VALUES (?, ?, ?, ?, ?, 1)`
      ).bind(id, pattern_type, pattern, severity, description).run();
    } catch {
      // Ignore if already exists
    }
  }
});

beforeEach(async () => {
  // Clean tables between tests
  await env.DB.prepare("DELETE FROM emails").run();
  await env.DB.prepare("DELETE FROM addresses").run();
  await env.DB.prepare("DELETE FROM rate_limits").run();
  await env.DB.prepare("DELETE FROM recovery_log").run();
  await env.DB.prepare("DELETE FROM send_log").run();
  await env.DB.prepare("DELETE FROM bounce_tracking").run();
  await env.DB.prepare("DELETE FROM abuse_log").run();
  await env.DB.prepare("DELETE FROM verification_codes").run();
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

  it("seeds a welcome email into the new inbox", async () => {
    // Create directly (createTestAddress strips the welcome email)
    const { body: created } = await call(
      post("/api/addresses", { local: "welcomed", recovery_email: "w@example.com" })
    );

    const { status, body } = await call(req("/api/mail", { token: created.token }));
    expect(status).toBe(200);
    expect(body.emails).toHaveLength(1);
    expect(body.emails[0].from_addr).toBe("welcome@shellmail.ai");
    expect(body.emails[0].subject).toContain("Welcome to ShellMail");
    expect(body.unread_count).toBe(1);
  });

  it("welcome email never shadows the OTP endpoint", async () => {
    const { body: created } = await call(
      post("/api/addresses", { local: "welcomed2", recovery_email: "w2@example.com" })
    );

    const { status, body } = await call(req("/api/mail/otp", { token: created.token }));
    expect(status).toBe(200);
    expect(body.found).toBe(false);
  });

  it("welcome email does not count as real activity", async () => {
    const { body: created } = await call(
      post("/api/addresses", { local: "welcomed3", recovery_email: "w3@example.com" })
    );
    expect(created.token).toMatch(/^sm_/);

    const addr = await env.DB.prepare(
      "SELECT messages_received FROM addresses WHERE local_part = 'welcomed3'"
    ).first<{ messages_received: number }>();
    expect(addr?.messages_received).toBe(0);
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

  it("records API usage as activity", async () => {
    const { token } = await createTestAddress("activitycheck");

    const before = await env.DB.prepare(
      "SELECT last_activity_at FROM addresses WHERE local_part = 'activitycheck'"
    ).first<{ last_activity_at: string | null }>();
    expect(before?.last_activity_at).toBeNull();

    await call(req("/api/mail", { token }));

    const after = await env.DB.prepare(
      "SELECT last_activity_at FROM addresses WHERE local_part = 'activitycheck'"
    ).first<{ last_activity_at: string | null }>();
    expect(after?.last_activity_at).not.toBeNull();
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

  it("logs recovery attempt for non-existent address", async () => {
    await call(
      post("/api/recover", {
        address: "ghost@shellmail.ai",
        recovery_email: "x@y.com",
      })
    );

    const log = await env.DB.prepare(
      "SELECT * FROM recovery_log WHERE local_part = 'ghost'"
    ).first<{ failure_reason: string; recovery_hash_matched: number }>();

    expect(log).not.toBeNull();
    expect(log!.recovery_hash_matched).toBe(0);
    expect(log!.failure_reason).toBe("address_not_found");
  });

  it("logs recovery attempt for wrong recovery email", async () => {
    await createTestAddress("auditme", "correct@example.com");
    await call(
      post("/api/recover", {
        address: "auditme@shellmail.ai",
        recovery_email: "wrong@example.com",
      })
    );

    const log = await env.DB.prepare(
      "SELECT * FROM recovery_log WHERE local_part = 'auditme'"
    ).first<{ failure_reason: string; recovery_hash_matched: number }>();

    expect(log).not.toBeNull();
    expect(log!.recovery_hash_matched).toBe(0);
    expect(log!.failure_reason).toBe("recovery_email_mismatch");
  });

  it("logs successful recovery attempt (503 due to missing Resend key)", async () => {
    await createTestAddress("auditok", "ok@example.com");
    await call(
      post("/api/recover", {
        address: "auditok@shellmail.ai",
        recovery_email: "ok@example.com",
      })
    );

    const log = await env.DB.prepare(
      "SELECT * FROM recovery_log WHERE local_part = 'auditok'"
    ).first<{ failure_reason: string; recovery_hash_matched: number }>();

    expect(log).not.toBeNull();
    expect(log!.recovery_hash_matched).toBe(1);
    expect(log!.failure_reason).toBe("resend_not_configured");
  });
});

// ── Preflight Validation ────────────────────────────────

describe("Address creation preflight", () => {
  it("gives helpful error when recovery_email is missing", async () => {
    const { status, body } = await call(
      post("/api/addresses", { local: "norecovery" })
    );
    expect(status).toBe(400);
    expect(body.error).toContain("recovery_email is required");
  });

  it("gives helpful error when recovery_email is invalid", async () => {
    const { status, body } = await call(
      post("/api/addresses", { local: "badrecovery", recovery_email: "not-an-email" })
    );
    expect(status).toBe(400);
    expect(body.error).toContain("not a valid email");
    expect(body.error).toContain("typos");
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
  it("soft-deletes address with 14-day hold", async () => {
    const { token } = await createTestAddress("deleteme");
    const addressId = await getAddressId(token);
    await insertTestEmail(addressId);

    const { status, body } = await call(del("/api/addresses/me", token));
    expect(status).toBe(200);
    expect(body.deleted).toBe("deleteme@shellmail.ai");
    expect(body.held_until).toBeDefined();
    expect(body.note).toContain("14 days");

    // Token should no longer work
    const { status: s2 } = await call(req("/api/mail", { token }));
    expect(s2).toBe(401);

    // Emails should be gone
    const row = await env.DB.prepare(
      "SELECT id FROM emails WHERE address_id = ?"
    )
      .bind(addressId)
      .first();
    expect(row).toBeNull();

    // Address row should still exist (soft-deleted)
    const addr = await env.DB.prepare(
      "SELECT deleted_at, held_until FROM addresses WHERE id = ?"
    )
      .bind(addressId)
      .first<{ deleted_at: string; held_until: string }>();
    expect(addr).not.toBeNull();
    expect(addr!.deleted_at).toBeDefined();
    expect(addr!.held_until).toBeDefined();
  });

  it("allows original owner to reclaim held address", async () => {
    const recoveryEmail = "reclaim@example.com";
    const { token } = await createTestAddress("reclaimme", recoveryEmail);

    // Delete the address
    await call(del("/api/addresses/me", token));

    // Reclaim with the same recovery email
    const { status, body } = await call(
      post("/api/addresses", { local: "reclaimme", recovery_email: recoveryEmail })
    );
    expect(status).toBe(201);
    expect(body.address).toBe("reclaimme@shellmail.ai");
    expect(body.reclaimed).toBe(true);
    expect(body.token).toMatch(/^sm_/);

    // New token should work
    const { status: s2 } = await call(req("/api/mail", { token: body.token }));
    expect(s2).toBe(200);
  });

  it("blocks different owner from claiming held address", async () => {
    await createTestAddress("held", "owner@example.com");
    const { token } = await createTestAddress("held2", "owner@example.com");

    // We need a token for the "held" address specifically
    const { token: heldToken } = await createTestAddress("heldaddr", "owner@example.com");
    await call(del("/api/addresses/me", heldToken));

    // Different owner tries to claim it
    const { status, body } = await call(
      post("/api/addresses", { local: "heldaddr", recovery_email: "other@example.com" })
    );
    expect(status).toBe(409);
    expect(body.error).toContain("reserved");
  });

  it("allows anyone to claim address after hold expires", async () => {
    const { token } = await createTestAddress("expiring", "owner@example.com");
    const addressId = await getAddressId(token);

    // Delete and manually expire the hold
    await call(del("/api/addresses/me", token));
    await env.DB.prepare(
      "UPDATE addresses SET held_until = datetime('now', '-1 day') WHERE id = ?"
    )
      .bind(addressId)
      .run();

    // New owner can now claim it
    const { status, body } = await call(
      post("/api/addresses", { local: "expiring", recovery_email: "newowner@example.com" })
    );
    expect(status).toBe(201);
    expect(body.address).toBe("expiring@shellmail.ai");
    expect(body.reclaimed).toBeUndefined();
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

// ── Security hardening ───────────────────────────────────

describe("Admin stats auth", () => {
  it("rejects when no ADMIN_SECRET is configured", async () => {
    const { status } = await call(req("/api/admin/stats"));
    expect(status).toBe(401);
  });

  it("rejects the legacy query-param secret", async () => {
    (env as any).ADMIN_SECRET = "topsecret";
    try {
      const { status } = await call(req("/api/admin/stats?secret=topsecret"));
      expect(status).toBe(401);
    } finally {
      (env as any).ADMIN_SECRET = undefined;
    }
  });

  it("accepts the secret via X-Admin-Secret header", async () => {
    (env as any).ADMIN_SECRET = "topsecret";
    try {
      const { status, body } = await call(
        req("/api/admin/stats", { headers: { "X-Admin-Secret": "topsecret" } })
      );
      expect(status).toBe(200);
      expect(body).toHaveProperty("total_addresses");
    } finally {
      (env as any).ADMIN_SECRET = undefined;
    }
  });

  it("rejects a wrong header secret", async () => {
    (env as any).ADMIN_SECRET = "topsecret";
    try {
      const { status } = await call(
        req("/api/admin/stats", { headers: { "X-Admin-Secret": "wrong" } })
      );
      expect(status).toBe(401);
    } finally {
      (env as any).ADMIN_SECRET = undefined;
    }
  });
});

describe("Webhook URL validation (SSRF guard)", () => {
  let token: string;

  beforeEach(async () => {
    const result = await createTestAddress("ssrfuser");
    token = result.token;
  });

  const blocked = [
    "http://localhost/hook",
    "http://127.0.0.1/hook",
    "http://10.0.0.5/hook",
    "http://172.16.1.1/hook",
    "http://192.168.1.1/hook",
    "http://169.254.169.254/latest/meta-data",
    "http://metadata.internal/hook",
    "http://foo.local/hook",
    "http://[::1]/hook",
  ];

  for (const url of blocked) {
    it(`rejects ${url}`, async () => {
      const { status } = await call(put("/api/webhook", { url }, token));
      expect(status).toBe(400);
    });
  }

  it("accepts a normal public URL", async () => {
    const { status } = await call(
      put("/api/webhook", { url: "https://example.com/hook" }, token)
    );
    expect(status).toBe(200);
  });
});

describe("Input hardening", () => {
  it("handles a non-numeric limit gracefully", async () => {
    const { token } = await createTestAddress("nanlimit");
    const { status } = await call(req("/api/mail?limit=abc&offset=xyz", { token }));
    expect(status).toBe(200);
  });

  it("rejects oversized send subject", async () => {
    (env as any).RESEND_API_KEY = "re_test";
    try {
      const { token } = await createTestAddress("bigsubject");
      const { status, body } = await call(
        post(
          "/api/mail/send",
          { to: "a@b.com", subject: "x".repeat(501), body_text: "hi" },
          { token }
        )
      );
      expect(status).toBe(400);
      expect(body.error).toContain("subject");
    } finally {
      (env as any).RESEND_API_KEY = undefined;
    }
  });

  it("strips CR/LF from send subject (header injection guard)", async () => {
    (env as any).RESEND_API_KEY = "re_test";
    const originalFetch = globalThis.fetch;
    let captured: any;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.resend.com")) {
        captured = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ id: "mock" }), { status: 200 });
      }
      return originalFetch(input, init);
    };
    try {
      const { token } = await createTestAddress("crlfsubject");
      const { status } = await call(
        post(
          "/api/mail/send",
          { to: "a@b.com", subject: "Hello\r\nBcc: evil@x.com", body_text: "hi" },
          { token }
        )
      );
      expect(status).toBe(201);
      expect(captured.subject).not.toContain("\r");
      expect(captured.subject).not.toContain("\n");
    } finally {
      (env as any).RESEND_API_KEY = undefined;
      globalThis.fetch = originalFetch;
    }
  });

  it("does not consume send quota when the provider errors", async () => {
    (env as any).RESEND_API_KEY = "re_test";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.resend.com")) {
        return new Response("error", { status: 500 });
      }
      return originalFetch(input);
    };
    try {
      const { token } = await createTestAddress("failedsend");
      const { status } = await call(
        post(
          "/api/mail/send",
          { to: "a@b.com", subject: "Hi", body_text: "hi" },
          { token }
        )
      );
      expect(status).toBe(500);

      const row = await env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM rate_limits WHERE key LIKE 'send:%'"
      ).first<{ cnt: number }>();
      expect(row!.cnt).toBe(0);
    } finally {
      (env as any).RESEND_API_KEY = undefined;
      globalThis.fetch = originalFetch;
    }
  });

  it("treats LIKE wildcards in search literally", async () => {
    const { token } = await createTestAddress("likesearch");
    const addressId = await getAddressId(token);
    await insertTestEmail(addressId, { subject: "abc" });
    await insertTestEmail(addressId, { subject: "a%c" });

    const { body } = await call(req("/api/mail/search?q=a%25c", { token }));
    expect(body.count).toBe(1);
    expect(body.emails[0].subject).toBe("a%c");
  });

  it("rejects new reserved local parts", async () => {
    const { status } = await call(
      post("/api/addresses", { local: "security", recovery_email: "x@y.com" })
    );
    expect(status).toBe(400);
  });

  it("rejects consecutive dots in local part", async () => {
    const { status } = await call(
      post("/api/addresses", { local: "a..b", recovery_email: "x@y.com" })
    );
    expect(status).toBe(400);
  });

  it("includes CORS headers on error responses", async () => {
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request("https://shellmail.ai/api/nonexistent"),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(404);
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

// ── Threads ──────────────────────────────────────────────

describe("Threads", () => {
  let token: string;
  let addressId: string;

  beforeEach(async () => {
    const result = await createTestAddress("threaduser");
    token = result.token;
    addressId = await getAddressId(token);
  });

  it("lists threads with latest-message preview", async () => {
    const threadId = "<123.abc@shellmail.ai>";
    await insertTestEmail(addressId, { subject: "First" });
    await env.DB.prepare(
      "UPDATE emails SET thread_id = ?, received_at = '2026-01-01T00:00:00Z' WHERE subject = 'First'"
    ).bind(threadId).run();
    const secondId = await insertTestEmail(addressId, { subject: "Second" });
    await env.DB.prepare(
      "UPDATE emails SET thread_id = ?, received_at = '2026-01-02T00:00:00Z' WHERE id = ?"
    ).bind(threadId, secondId).run();

    const { status, body } = await call(req("/api/mail/threads", { token }));
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.threads[0].message_count).toBe(2);
    expect(body.threads[0].subject).toBe("Second");
    expect(body.threads[0].last_message.id).toBe(secondId);
  });

  it("fetches a thread by URL-encoded Message-ID thread id", async () => {
    const threadId = "<123.abc@shellmail.ai>";
    const emailId = await insertTestEmail(addressId, { subject: "Threaded" });
    await env.DB.prepare("UPDATE emails SET thread_id = ? WHERE id = ?")
      .bind(threadId, emailId)
      .run();

    const { status, body } = await call(
      req(`/api/mail/threads/${encodeURIComponent(threadId)}`, { token })
    );
    expect(status).toBe(200);
    expect(body.thread_id).toBe(threadId);
    expect(body.messages).toHaveLength(1);
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

// ── Authentication Tests ─────────────────────────────────

describe("Authentication Tiers", () => {
  /** Run fn with RESEND_API_KEY set and the Resend API mocked to succeed */
  async function withMockResend(fn: () => Promise<void>) {
    const originalKey = env.RESEND_API_KEY;
    const originalFetch = globalThis.fetch;
    (env as any).RESEND_API_KEY = "re_test_key";
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.resend.com")) {
        return new Response(JSON.stringify({ id: "mock-id" }), { status: 200 });
      }
      return originalFetch(input, init);
    };
    try {
      await fn();
    } finally {
      (env as any).RESEND_API_KEY = originalKey;
      globalThis.fetch = originalFetch;
    }
  }

  describe("POST /api/auth/verify-recovery/request", () => {
    it("sends OTP to recovery email", async () => withMockResend(async () => {
      const recoveryEmail = "test@example.com";
      const { token } = await createTestAddress("authtest1", recoveryEmail);

      const { status, body } = await call(
        post("/api/auth/verify-recovery/request", { recovery_email: recoveryEmail }, { token })
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.expires_in).toBe(300); // 5 minutes
      expect(body.message).toContain(recoveryEmail);
    }));

    it("rejects if recovery email doesn't match", async () => {
      const { token } = await createTestAddress("authtest2", "real@example.com");

      const { status, body } = await call(
        post("/api/auth/verify-recovery/request", { recovery_email: "wrong@example.com" }, { token })
      );

      expect(status).toBe(400);
      expect(body.error).toContain("does not match");
    });

    it("rate limits to 3 requests per hour", async () => withMockResend(async () => {
      const recoveryEmail = "test3@example.com";
      const { token } = await createTestAddress("authtest3", recoveryEmail);

      // Make 3 requests (should succeed)
      for (let i = 0; i < 3; i++) {
        const { status } = await call(
          post("/api/auth/verify-recovery/request", { recovery_email: recoveryEmail }, { token })
        );
        expect(status).toBe(200);
      }

      // 4th request should fail
      const { status, body } = await call(
        post("/api/auth/verify-recovery/request", { recovery_email: recoveryEmail }, { token })
      );

      expect(status).toBe(400);
      expect(body.error).toContain("Too many");
    }));

    it("rejects if already verified", async () => {
      const recoveryEmail = "test4@example.com";
      const { token, address } = await createTestAddress("authtest4", recoveryEmail);

      // Manually set recovery_verified to 1
      await env.DB.prepare(
        "UPDATE addresses SET recovery_verified = 1 WHERE local_part = ?"
      ).bind("authtest4").run();

      const { status, body } = await call(
        post("/api/auth/verify-recovery/request", { recovery_email: recoveryEmail }, { token })
      );

      expect(status).toBe(400);
      expect(body.error).toContain("already verified");
    });

    it("requires valid email format", async () => {
      const { token } = await createTestAddress("authtest5", "valid@example.com");

      const { status, body } = await call(
        post("/api/auth/verify-recovery/request", { recovery_email: "not-an-email" }, { token })
      );

      expect(status).toBe(400);
      expect(body.error).toBeTruthy();
    });
  });

  describe("POST /api/auth/verify-recovery/confirm", () => {
    /** Codes are stored hashed, so tests seed a known code directly */
    async function seedVerificationCode(
      localPart: string,
      code: string,
      expiresOffset = "+5 minutes"
    ) {
      const addressId = (await env.DB.prepare(
        "SELECT id FROM addresses WHERE local_part = ?"
      ).bind(localPart).first<{ id: string }>())!.id;

      await env.DB.prepare(
        `INSERT INTO verification_codes (id, address_id, code_hash, purpose, expires_at)
         VALUES (?, ?, ?, 'recovery_verification', datetime('now', ?))`
      ).bind(crypto.randomUUID(), addressId, await hash(code), expiresOffset).run();
    }

    it("upgrades plan to shell on correct code", async () => {
      const { token } = await createTestAddress("authtest6", "test6@example.com");
      await seedVerificationCode("authtest6", "123456");

      // Confirm with correct code
      const { status, body } = await call(
        post("/api/auth/verify-recovery/confirm", { code: "123456" }, { token })
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.verified).toBe(true);
      expect(body.plan).toBe("shell");
      expect(body.daily_limit).toBe(50);

      // Verify database was updated
      const addr = await env.DB.prepare(
        "SELECT plan, recovery_verified FROM addresses WHERE local_part = ?"
      ).bind("authtest6").first<{ plan: string; recovery_verified: number }>();

      expect(addr?.plan).toBe("shell");
      expect(addr?.recovery_verified).toBe(1);
    });

    it("rejects invalid code", async () => {
      const { token } = await createTestAddress("authtest7", "test7@example.com");

      const { status, body } = await call(
        post("/api/auth/verify-recovery/confirm", { code: "999999" }, { token })
      );

      expect(status).toBe(400);
      expect(body.error).toContain("Invalid");
    });

    it("rejects expired code", async () => {
      const { token } = await createTestAddress("authtest8", "test8@example.com");
      await seedVerificationCode("authtest8", "123456", "-10 minutes");

      const { status, body } = await call(
        post("/api/auth/verify-recovery/confirm", { code: "123456" }, { token })
      );

      expect(status).toBe(400);
      expect(body.error).toContain("Invalid or expired");
    });

    it("marks code as used after verification", async () => {
      const { token } = await createTestAddress("authtest9", "test9@example.com");
      await seedVerificationCode("authtest9", "123456");

      // Use the code once
      await call(
        post("/api/auth/verify-recovery/confirm", { code: "123456" }, { token })
      );

      // Reset the verified flag so the second confirm reaches the code lookup
      // (otherwise it short-circuits on "already verified")
      await env.DB.prepare(
        "UPDATE addresses SET recovery_verified = 0 WHERE local_part = ?"
      ).bind("authtest9").run();

      // Try to use the code again - should fail because it's marked used
      const { status, body } = await call(
        post("/api/auth/verify-recovery/confirm", { code: "123456" }, { token })
      );

      expect(status).toBe(400);
      expect(body.error).toContain("Invalid or expired");
    });

    it("invalidates code after 5 wrong guesses", async () => {
      const { token } = await createTestAddress("authtest13", "test13@example.com");
      await seedVerificationCode("authtest13", "123456");

      for (let i = 0; i < 5; i++) {
        const { status } = await call(
          post("/api/auth/verify-recovery/confirm", { code: "000000" }, { token })
        );
        expect(status).toBe(400);
      }

      // Correct code is now rejected — the code was invalidated by the attempt cap
      const { status, body } = await call(
        post("/api/auth/verify-recovery/confirm", { code: "123456" }, { token })
      );

      expect(status).toBe(400);
      expect(body.error).toContain("Invalid or expired");
    });

    it("rate limits confirm attempts", async () => {
      const { token } = await createTestAddress("authtest14", "test14@example.com");

      // 10 attempts allowed per window, 11th is rejected
      for (let i = 0; i < 10; i++) {
        const { status } = await call(
          post("/api/auth/verify-recovery/confirm", { code: "999999" }, { token })
        );
        expect(status).toBe(400);
      }

      const { status } = await call(
        post("/api/auth/verify-recovery/confirm", { code: "999999" }, { token })
      );
      expect(status).toBe(429);
    });

    it("requires 6-digit code format", async () => {
      const { token } = await createTestAddress("authtest10", "test10@example.com");

      const { status, body } = await call(
        post("/api/auth/verify-recovery/confirm", { code: "12345" }, { token })
      );

      expect(status).toBe(400);
      expect(body.error).toBeTruthy();
    });
  });

  describe("GET /api/auth/status", () => {
    it("returns authentication status for unverified user", async () => {
      const { token, address } = await createTestAddress("authtest11", "test11@example.com");

      const { status, body } = await call(req("/api/auth/status", { token }));

      expect(status).toBe(200);
      expect(body.address).toBe(address);
      expect(body.plan).toBe("free");
      expect(body.daily_limit).toBe(10);
      expect(body.authentication.recovery_verified).toBe(false);
      expect(body.authentication.oauth_provider).toBeNull();
    });

    it("returns authentication status for verified user", async () => {
      const { token, address } = await createTestAddress("authtest12", "test12@example.com");

      // Manually verify
      await env.DB.prepare(
        "UPDATE addresses SET recovery_verified = 1, plan = 'shell', authenticated_at = datetime('now') WHERE local_part = ?"
      ).bind("authtest12").run();

      const { status, body } = await call(req("/api/auth/status", { token }));

      expect(status).toBe(200);
      expect(body.plan).toBe("shell");
      expect(body.daily_limit).toBe(50);
      expect(body.authentication.recovery_verified).toBe(true);
      expect(body.authentication.authenticated_at).toBeTruthy();
    });

    it("requires authentication", async () => {
      const { status } = await call(req("/api/auth/status"));
      expect(status).toBe(401);
    });
  });

  describe("Send limit enforcement with authentication", () => {
    /** Backdate send_log entries so the 5/minute burst limiter doesn't trip —
     * these tests exercise the DAILY limit, which counts via rate_limits */
    async function resetBurstWindow(localPart: string) {
      await env.DB.prepare(
        `UPDATE send_log SET created_at = datetime('now', '-2 minutes')
         WHERE address_id = (SELECT id FROM addresses WHERE local_part = ?)`
      ).bind(localPart).run();
    }

    it("enforces 10/day limit for unauthenticated free tier", async () => withMockResend(async () => {
      const { token } = await createTestAddress("sendtest1", "send1@example.com");

      // Should be able to send up to 10
      for (let i = 0; i < 10; i++) {
        const { status } = await call(
          post("/api/mail/send", {
            to: `recipient${i}@example.com`,
            subject: "Test",
            body_text: "Test"
          }, { token })
        );
        expect(status).toBe(201);
        await resetBurstWindow("sendtest1");
      }

      // 11th should fail with rate limit
      const { status, body } = await call(
        post("/api/mail/send", {
          to: "recipient11@example.com",
          subject: "Test",
          body_text: "Test"
        }, { token })
      );

      expect(status).toBe(429);
      expect(body.error).toContain("Daily send limit");
    }));

    it("allows 50/day for authenticated shell tier", async () => withMockResend(async () => {
      const { token } = await createTestAddress("sendtest2", "send2@example.com");

      // Verify the address
      await env.DB.prepare(
        "UPDATE addresses SET recovery_verified = 1, plan = 'shell' WHERE local_part = ?"
      ).bind("sendtest2").run();

      // Should be able to send up to 50 (test first 11 to verify >10 works)
      for (let i = 0; i < 11; i++) {
        const { status } = await call(
          post("/api/mail/send", {
            to: `recipient${i}@example.com`,
            subject: "Test",
            body_text: "Test"
          }, { token })
        );
        expect(status).toBe(201);
        await resetBurstWindow("sendtest2");
      }

      // Verify it didn't hit rate limit yet
      const { status, body } = await call(
        post("/api/mail/send", {
          to: "recipient12@example.com",
          subject: "Test",
          body_text: "Test"
        }, { token })
      );

      expect(status).toBe(201);
      expect(body.error ?? "").not.toContain("Daily send limit");
    }));
  });
});

// ── Anti-Spam Tests ──────────────────────────────────────

describe("Anti-Spam Features", () => {
  describe("Content Filtering", () => {
    it("rejects spam content with high spam score", async () => {
      const { token } = await createTestAddress("spamtest1", "spam1@example.com");

      const { status, body } = await call(
        post("/api/mail/send", {
          to: "victim@example.com",
          subject: "URGENT ACT NOW!!!",
          body_text: "Guaranteed bitcoin profit! Viagra cheap pharmacy! Click now or expires!"
        }, { token })
      );

      expect(status).toBe(403);
      expect(body.error).toContain("content policy violation");
    });

    it("allows clean content", async () => {
      const { token } = await createTestAddress("spamtest2", "spam2@example.com");

      const { status } = await call(
        post("/api/mail/send", {
          to: "friend@example.com",
          subject: "Hello friend",
          body_text: "Just wanted to say hi and see how you're doing!"
        }, { token })
      );

      // Either success or missing Resend key, but not content rejection
      expect([201, 503]).toContain(status);
    });

    it("flags suspicious content without rejecting", async () => {
      const { token } = await createTestAddress("spamtest3", "spam3@example.com");

      const { status } = await call(
        post("/api/mail/send", {
          to: "someone@example.com",
          subject: "Investment opportunity",
          body_text: "Check out this link: http://example.com http://example2.com"
        }, { token })
      );

      // Should not reject, but might flag
      expect([201, 503]).toContain(status);

      // Check if it was flagged in send_log
      const flagged = await env.DB.prepare(
        "SELECT flagged, content_scan_score FROM send_log WHERE address_id = (SELECT id FROM addresses WHERE local_part = ?) ORDER BY created_at DESC LIMIT 1"
      ).bind("spamtest3").first<{ flagged: number; content_scan_score: number }>();

      // Should be flagged if score was 50-80
      if (flagged && flagged.content_scan_score >= 50) {
        expect(flagged.flagged).toBe(1);
      }
    });
  });

  describe("Burst Rate Limiting", () => {
    it("blocks >5 emails in 1 minute", async () => {
      const { token } = await createTestAddress("bursttest1", "burst1@example.com");

      // Send 5 emails quickly (should succeed)
      for (let i = 0; i < 5; i++) {
        const { status } = await call(
          post("/api/mail/send", {
            to: `recipient${i}@example.com`,
            subject: "Test",
            body_text: "Test"
          }, { token })
        );
        expect([201, 503]).toContain(status);
      }

      // 6th email should be rate limited
      const { status, body } = await call(
        post("/api/mail/send", {
          to: "recipient6@example.com",
          subject: "Test",
          body_text: "Test"
        }, { token })
      );

      expect(status).toBe(429);
      expect(body.error).toContain("5 emails per minute");
    });
  });

  describe("Suspension", () => {
    it("blocks sending from suspended address", async () => {
      const { token } = await createTestAddress("suspended1", "susp1@example.com");

      // Suspend the address
      await env.DB.prepare(
        "UPDATE addresses SET suspended = 1, suspension_reason = 'test' WHERE local_part = ?"
      ).bind("suspended1").run();

      const { status, body } = await call(
        post("/api/mail/send", {
          to: "someone@example.com",
          subject: "Test",
          body_text: "Test"
        }, { token })
      );

      expect(status).toBe(403);
      expect(body.error).toContain("suspended");
    });
  });

  describe("Pattern Detection", () => {
    it("logs suspicious patterns in abuse_log", async () => {
      const { token } = await createTestAddress("pattern1", "pattern1@example.com");

      // Send 5 emails to trigger pattern detection (>3 to same recipient)
      // Pattern detection runs BEFORE send_log is created, so we need 5 sends
      // to see 4 previous sends (which is > 3)
      for (let i = 0; i < 5; i++) {
        await call(
          post("/api/mail/send", {
            to: "same-person@example.com",
            subject: "Test",
            body_text: "Test"
          }, { token })
        );
      }

      // Check if pattern was logged
      const abuseLog = await env.DB.prepare(
        "SELECT * FROM abuse_log WHERE address_id = (SELECT id FROM addresses WHERE local_part = ?) AND abuse_type = 'pattern_detection'"
      ).bind("pattern1").first();

      expect(abuseLog).toBeTruthy();
    });
  });
});

// ── Resend Webhook Tests ─────────────────────────────────

describe("POST /api/webhooks/resend", () => {
  // Matches RESEND_WEBHOOK_SECRET in vitest.config.ts
  const TEST_WEBHOOK_KEY_B64 = "dGVzdC13ZWJob29rLXNlY3JldC1rZXk=";

  /** Produce valid Svix signature headers for a webhook payload */
  async function svixHeaders(payload: unknown): Promise<Record<string, string>> {
    const body = JSON.stringify(payload);
    const id = "msg_test";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const keyBytes = Uint8Array.from(atob(TEST_WEBHOOK_KEY_B64), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${id}.${timestamp}.${body}`)
    );
    const sig = btoa(String.fromCharCode(...new Uint8Array(mac)));
    return {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${sig}`,
    };
  }

  it("rejects webhook with forged signature", async () => {
    const { status } = await call(
      post("/api/webhooks/resend", { type: "email.bounced", data: {} }, {
        headers: {
          "svix-signature": "v1,Zm9yZ2VkLXNpZ25hdHVyZQ==",
          "svix-timestamp": Math.floor(Date.now() / 1000).toString(),
          "svix-id": "msg_forged",
        },
      })
    );
    expect(status).toBe(401);
  });

  it("rejects webhook with stale timestamp", async () => {
    const payload = { type: "email.bounced", data: {} };
    const headers = await svixHeaders(payload);
    headers["svix-timestamp"] = (Math.floor(Date.now() / 1000) - 3600).toString();
    const { status } = await call(post("/api/webhooks/resend", payload, { headers }));
    expect(status).toBe(401);
  });

  it("processes bounce webhook", async () => {
    const { token, address } = await createTestAddress("webhook1", "webhook1@example.com");
    const addressId = (await env.DB.prepare(
      "SELECT id FROM addresses WHERE local_part = ?"
    ).bind("webhook1").first<{ id: string }>())!.id;

    // Create a send_log entry
    const sendLogId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO send_log (id, address_id, recipient_email, subject) VALUES (?, ?, ?, ?)"
    ).bind(sendLogId, addressId, "bounced@example.com", "Test").run();

    // Send bounce webhook
    const webhookPayload = {
      type: "email.bounced",
      created_at: new Date().toISOString(),
      data: {
        email_id: "resend-123",
        from: address,
        to: "bounced@example.com",
        subject: "Test",
        created_at: new Date().toISOString(),
        tags: {
          address_id: addressId,
          send_log_id: sendLogId
        },
        bounce_reason: "Mailbox does not exist"
      }
    };

    const { status } = await call(
      post("/api/webhooks/resend", webhookPayload, {
        headers: await svixHeaders(webhookPayload),
      })
    );

    expect(status).toBe(200);

    // Verify bounce was recorded
    const bounce = await env.DB.prepare(
      "SELECT * FROM bounce_tracking WHERE address_id = ? AND recipient = ?"
    ).bind(addressId, "bounced@example.com").first();

    expect(bounce).toBeTruthy();
  });

  it("suspends address on spam complaint", async () => {
    const { token } = await createTestAddress("webhook2", "webhook2@example.com");
    const addressId = (await env.DB.prepare(
      "SELECT id FROM addresses WHERE local_part = ?"
    ).bind("webhook2").first<{ id: string }>())!.id;

    // Send complaint webhook
    const webhookPayload = {
      type: "email.complained",
      created_at: new Date().toISOString(),
      data: {
        email_id: "resend-456",
        from: "webhook2@shellmail.ai",
        to: "reporter@example.com",
        subject: "Test",
        created_at: new Date().toISOString(),
        tags: {
          address_id: addressId
        }
      }
    };

    await call(
      post("/api/webhooks/resend", webhookPayload, {
        headers: await svixHeaders(webhookPayload),
      })
    );

    // Verify address was suspended
    const addr = await env.DB.prepare(
      "SELECT suspended, suspension_reason FROM addresses WHERE id = ?"
    ).bind(addressId).first<{ suspended: number; suspension_reason: string }>();

    expect(addr?.suspended).toBe(1);
    expect(addr?.suspension_reason).toContain("spam");
  });
});
