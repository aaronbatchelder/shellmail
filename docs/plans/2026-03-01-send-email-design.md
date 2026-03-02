# Send Email Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add outbound email capability via Resend API with tiered rate limits and sent mail storage.

**Architecture:** New `POST /api/mail/send` endpoint authenticates user, checks rate limits by plan tier, sends via Resend API, stores sent email in DB with `direction=outbound`. Reply threading uses `reply_to_id` to set proper email headers.

**Tech Stack:** Cloudflare Workers, D1, Resend API, TypeScript

---

## Task 1: Database Migration

**Files:**
- Create: `migrations/0007_send_email.sql`

**Step 1: Create migration file**

```sql
-- Add columns for send email feature
ALTER TABLE emails ADD COLUMN direction TEXT DEFAULT 'inbound';
ALTER TABLE emails ADD COLUMN to_addr TEXT;
ALTER TABLE emails ADD COLUMN message_id TEXT;

-- Track sent messages per address
ALTER TABLE addresses ADD COLUMN messages_sent INTEGER DEFAULT 0;

-- Index for filtering by direction
CREATE INDEX idx_emails_direction ON emails(address_id, direction);
```

**Step 2: Apply migration locally**

Run: `wrangler d1 execute shellmail --local --file=migrations/0007_send_email.sql`
Expected: Migration applied successfully

**Step 3: Commit**

```bash
git add migrations/0007_send_email.sql
git commit -m "feat: add migration for send email columns"
```

---

## Task 2: Add Types

**Files:**
- Modify: `src/types.ts`

**Step 1: Add SendEmailRequest type and update Env**

Add to `src/types.ts`:

```typescript
export interface SendEmailRequest {
  to: string;
  subject: string;
  body_text: string;
  body_html?: string;
  reply_to_id?: string;
}
```

Update `Env` interface to add:

```typescript
export interface Env {
  DB: D1Database;
  DOMAIN: string;
  ADMIN_SECRET?: string;
  RESEND_API_KEY?: string;  // Add this
  ctx?: ExecutionContext;
}
```

Update `Email` interface to add:

```typescript
export interface Email {
  // ... existing fields ...
  direction?: string;
  to_addr?: string;
  message_id?: string;
}
```

Update `Address` interface to add:

```typescript
export interface Address {
  // ... existing fields ...
  messages_sent: number;
}
```

**Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat: add types for send email feature"
```

---

## Task 3: Create Resend Send Function

**Files:**
- Create: `src/send.ts`

**Step 1: Create send.ts with Resend integration**

```typescript
/**
 * ShellMail — Send Email via Resend
 */

import { Env, Address } from "./types";
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
```

**Step 2: Commit**

```bash
git add src/send.ts
git commit -m "feat: add Resend email sending module"
```

---

## Task 4: Implement Send Endpoint

**Files:**
- Modify: `src/api.ts`

**Step 1: Add imports at top of api.ts**

```typescript
import { SendEmailRequest } from "./types";
import { sendViaResend, generateMessageId, getSendLimit } from "./send";
```

**Step 2: Add sendMail function after deleteMail function (~line 436)**

```typescript
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
  let originalFrom: string | undefined;

  if (body.reply_to_id) {
    const original = await env.DB.prepare(
      "SELECT from_addr, message_id FROM emails WHERE id = ? AND address_id = ?"
    )
      .bind(body.reply_to_id, addr.id)
      .first<{ from_addr: string; message_id: string | null }>();

    if (!original) {
      return error("reply_to_id not found", 404);
    }

    originalFrom = original.from_addr;

    if (original.message_id) {
      replyHeaders = {
        "In-Reply-To": original.message_id,
        "References": original.message_id,
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
  await env.DB.prepare(
    `INSERT INTO emails (id, address_id, from_addr, to_addr, subject, body_text, body_html, direction, message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'outbound', ?)`
  )
    .bind(
      emailId,
      addr.id,
      fromAddr,
      body.to,
      body.subject,
      body.body_text,
      body.body_html || null,
      messageId
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
```

**Step 3: Add route in matchRoute function (~line 668)**

After the `deleteAddress` route, add:

```typescript
if (method === "POST" && pathname === "/api/mail/send")
  return { handler: "sendMail" };
```

**Step 4: Add case in router switch (~line 775)**

After `deleteAddress` case, add:

```typescript
case "sendMail":
  response = await sendMail(request, env);
  break;
```

**Step 5: Commit**

```bash
git add src/api.ts
git commit -m "feat: implement POST /api/mail/send endpoint"
```

---

## Task 5: Add Sent Mail Listing

**Files:**
- Modify: `src/api.ts`

**Step 1: Add getSentMail function after sendMail**

```typescript
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
```

**Step 2: Add route for GET /api/mail/sent in matchRoute**

Add before the `/api/mail/:id` pattern match:

```typescript
if (method === "GET" && pathname === "/api/mail/sent")
  return { handler: "getSentMail" };
```

**Step 3: Add case in router switch**

```typescript
case "getSentMail":
  response = await getSentMail(request, env);
  break;
```

**Step 4: Commit**

```bash
git add src/api.ts
git commit -m "feat: add GET /api/mail/sent endpoint"
```

---

## Task 6: Update CLI

**Files:**
- Modify: `skill/scripts/shellmail.sh`

**Step 1: Add send and reply commands to usage**

Update the usage function to include:

```bash
  send <to>                 Send email (--subject, --body, --html)
  reply <id>                Reply to email (--body, --html)
  sent                      List sent emails
```

**Step 2: Add send command handler**

Add before the `*` catch-all case:

```bash
  send)
    [ -z "${1:-}" ] && { echo "Usage: shellmail send <to> --subject 'Subject' --body 'Body'" >&2; exit 1; }
    TO="$1"; shift
    SUBJECT=""
    BODY=""
    HTML=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --subject|-s) SUBJECT="$2"; shift 2 ;;
        --body|-b) BODY="$2"; shift 2 ;;
        --html) HTML="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    [ -z "$SUBJECT" ] && { echo "Error: --subject required" >&2; exit 1; }
    [ -z "$BODY" ] && { echo "Error: --body required" >&2; exit 1; }
    if command -v jq >/dev/null 2>&1; then
      json=$(jq -n --arg to "$TO" --arg subject "$SUBJECT" --arg body "$BODY" --arg html "$HTML" \
        '{to: $to, subject: $subject, body_text: $body} + (if $html != "" then {body_html: $html} else {} end)')
    else
      json=$(python3 -c "import sys, json; d={'to': sys.argv[1], 'subject': sys.argv[2], 'body_text': sys.argv[3]}; sys.argv[4] and d.update({'body_html': sys.argv[4]}); print(json.dumps(d))" "$TO" "$SUBJECT" "$BODY" "$HTML")
    fi
    printf '%s' "$json" | curl -sf -X POST "$API_URL/api/mail/send" \
      -H "$(auth_header)" \
      -H "Content-Type: application/json" \
      -d @-
    ;;

  reply)
    [ -z "${1:-}" ] && { echo "Usage: shellmail reply <email-id> --body 'Reply text'" >&2; exit 1; }
    REPLY_ID="$1"; shift
    BODY=""
    HTML=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --body|-b) BODY="$2"; shift 2 ;;
        --html) HTML="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    [ -z "$BODY" ] && { echo "Error: --body required" >&2; exit 1; }
    # Fetch original email to get recipient and subject
    ORIGINAL=$(curl -sf "$API_URL/api/mail/$(urlencode "$REPLY_ID")" -H "$(auth_header)")
    TO=$(echo "$ORIGINAL" | python3 -c "import sys, json; print(json.loads(sys.stdin.read())['from_addr'])")
    SUBJECT=$(echo "$ORIGINAL" | python3 -c "import sys, json; s=json.loads(sys.stdin.read())['subject']; print(s if s.startswith('Re:') else 'Re: '+s)")
    if command -v jq >/dev/null 2>&1; then
      json=$(jq -n --arg to "$TO" --arg subject "$SUBJECT" --arg body "$BODY" --arg html "$HTML" --arg reply "$REPLY_ID" \
        '{to: $to, subject: $subject, body_text: $body, reply_to_id: $reply} + (if $html != "" then {body_html: $html} else {} end)')
    else
      json=$(python3 -c "import sys, json; d={'to': sys.argv[1], 'subject': sys.argv[2], 'body_text': sys.argv[3], 'reply_to_id': sys.argv[5]}; sys.argv[4] and d.update({'body_html': sys.argv[4]}); print(json.dumps(d))" "$TO" "$SUBJECT" "$BODY" "$HTML" "$REPLY_ID")
    fi
    printf '%s' "$json" | curl -sf -X POST "$API_URL/api/mail/send" \
      -H "$(auth_header)" \
      -H "Content-Type: application/json" \
      -d @-
    ;;

  sent)
    LIMIT="50"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --limit) LIMIT="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    curl -sf "$API_URL/api/mail/sent?limit=${LIMIT}" -H "$(auth_header)"
    ;;
```

**Step 3: Commit**

```bash
git add skill/scripts/shellmail.sh
git commit -m "feat: add send, reply, sent commands to CLI"
```

---

## Task 7: Extract Message-ID from Inbound Emails

**Files:**
- Modify: `src/email.ts`

**Step 1: Extract message_id in parseEmail function**

Update the return type and add extraction:

```typescript
async function parseEmail(message: ForwardableEmailMessage): Promise<{
  from: string;
  fromName: string | null;
  to: string;
  subject: string;
  bodyText: string | null;
  bodyHtml: string | null;
  rawHeaders: string;
  messageId: string | null;  // Add this
}> {
```

Add after `rawHeaders` extraction:

```typescript
// Extract Message-ID
const messageId = message.headers.get("message-id") || null;
```

Update return to include `messageId`.

**Step 2: Store message_id in email insert**

Update the INSERT statement to include `message_id`:

```typescript
await env.DB.prepare(
  `INSERT INTO emails (id, address_id, from_addr, from_name, subject, body_text, body_html, raw_headers, otp_code, otp_link, otp_extracted, expires_at, message_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    parsed.messageId  // Add this
  )
  .run();
```

**Step 3: Commit**

```bash
git add src/email.ts
git commit -m "feat: extract and store message_id from inbound emails"
```

---

## Task 8: Add RESEND_API_KEY to Environment

**Files:**
- Modify: `wrangler.toml` (documentation only, actual secret via CLI)

**Step 1: Add secret via wrangler CLI**

Run: `wrangler secret put RESEND_API_KEY`
Enter your Resend API key when prompted.

**Step 2: Document in wrangler.toml comments**

Add comment at end of `wrangler.toml`:

```toml
# Secrets (set via `wrangler secret put`):
# - RESEND_API_KEY: API key from resend.com for outbound email
# - ADMIN_SECRET: Secret for admin endpoints
```

**Step 3: Commit**

```bash
git add wrangler.toml
git commit -m "docs: document RESEND_API_KEY secret"
```

---

## Task 9: Apply Migration to Production

**Step 1: Apply migration**

Run: `wrangler d1 execute shellmail --file=migrations/0007_send_email.sql`
Expected: Migration applied successfully

**Step 2: Deploy**

Run: `wrangler deploy`
Expected: Deployment successful

---

## Task 10: Manual Testing

**Step 1: Test send endpoint**

```bash
export SHELLMAIL_TOKEN="your-token"
shellmail send test@example.com --subject "Test" --body "Hello from ShellMail"
```
Expected: `{"ok":true,"id":"...","message_id":"..."}`

**Step 2: Test rate limiting**

Send 11 emails (for free plan):
Expected: 11th should return 429 with rate limit error

**Step 3: Test sent listing**

```bash
shellmail sent
```
Expected: List of sent emails

**Step 4: Test reply**

```bash
shellmail inbox
# Get an email ID
shellmail reply <email-id> --body "Thanks for your email"
```
Expected: Reply sent successfully

---

Plan complete and saved to `docs/plans/2026-03-01-send-email-design.md`.

**Two execution options:**

1. **Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

2. **Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
