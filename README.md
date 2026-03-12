<p align="center">
  <img src="public/logo.png" alt="ShellMail" width="180" style="border-radius: 24px;">
</p>

<h1 align="center">ShellMail</h1>

<p align="center">
  <strong>Instant OTP codes for your AI agent.</strong><br>
  Give your agent an inbox in 60 seconds. Block until the code arrives. Move on.
</p>

<p align="center">
  <a href="https://shellmail.ai">Website</a> •
  <a href="https://clawhub.ai/aaronbatchelder/shellmail">ClawHub</a> •
  <a href="https://www.npmjs.com/package/shellmail">npm</a> •
  <a href="https://shellmail.ai/openapi.json">OpenAPI</a>
</p>

---

```typescript
// Your agent needs a verification code. One call. Done.
const { code } = await mail.waitForOtp(30, 'github.com');
// → "847291"
```

## Quick Start

**Step 1** — Create an inbox:

```bash
npx shellmail setup
```

**Step 2** — Wait for an OTP in your agent:

```bash
# CLI — blocks until the code arrives (up to 30s)
shellmail otp -w 30 -f github.com

# API — long-poll directly
curl "https://shellmail.ai/api/mail/otp?timeout=30000&from=github.com" \
  -H "Authorization: Bearer sm_..."
# → {"found": true, "code": "847291", "from": "noreply@github.com"}
```

That's the whole flow. Full inbox, send/reply, webhooks, and threads are all there when you need them.

**For Claude Desktop / Cursor / Cline** — Add the MCP server:

```json
{
  "mcpServers": {
    "shellmail": {
      "command": "npx",
      "args": ["-y", "shellmail-mcp"],
      "env": {
        "SHELLMAIL_TOKEN": "sm_your_token_here"
      }
    }
  }
}
```

**For Claude Code users** — Install the plugin:

```bash
claude plugin install https://github.com/aaronbatchelder/shellmail
```

**For OpenClaw users** — Install the skill:

```bash
clawhub install shellmail
```

That's it. You now have `yourname@shellmail.ai` ready to send and receive mail.

## Why ShellMail?

Your agent is in the middle of a flow — sign up, verify, continue. It triggers an email verification and now needs the code. With a normal email provider that means IMAP, OAuth, polling loops, parsing, and hoping the code hasn't expired by the time you parse it.

With ShellMail:

1. **Create address** → Get a token (once, at setup)
2. **Trigger the verification email** → Whatever your agent is doing
3. **`GET /api/mail/otp?timeout=30000`** → Blocks up to 30s, returns the code the moment it arrives

OTPs are extracted automatically. No parsing. No polling loop. No timeouts to manage.

## Features

- **OTP Extraction** — Verification codes are automatically parsed out of every email
- **Long Polling** — `GET /api/mail/otp?timeout=30000` blocks up to 30s and returns the instant a code arrives
- **Sender Filtering** — Scope the wait to a specific domain: `?from=github.com`
- **Send & Receive** — Full email capability beyond OTPs: send, reply, archive
- **Webhooks** — Push notifications when mail arrives (HMAC-SHA256 signed)
- **Slack & Discord** — Native webhook formatting for Slack and Discord
- **Threads** — View conversations grouped by thread
- **Search** — Find emails by sender, content, or OTP presence
- **Multi-Inbox Profiles** — Manage multiple addresses with `shellmail profile`
- **TypeScript SDK** — First-class SDK: `npm install @shellmail/sdk`
- **Rate Limited** — Tiered send limits (Free: 10/day, Shell: 50/day, Reef: 100/day)
- **Edge-fast** — Runs on Cloudflare Workers globally

## CLI

```bash
# Install globally (optional)
npm install -g shellmail

# Or use npx
npx shellmail <command>
```

### Commands

```bash
# Setup & Status
shellmail setup              # Create new address interactively
shellmail status             # Check service status

# OTP — the main use case
shellmail otp                # Get latest OTP code
shellmail otp -w 30          # Wait up to 30s for OTP
shellmail otp -f github.com  # Wait for OTP from a specific sender

# Email
shellmail inbox              # List emails
shellmail inbox -u           # List unread only
shellmail read <id>          # Read specific email
shellmail send <to> -s "Subject" -b "Body"  # Send an email
shellmail reply <id> -b "Reply text"        # Reply to an email
shellmail sent               # List sent emails
shellmail search --otp       # Find emails with OTPs
shellmail search -q "verify" # Search by keyword

# Webhooks (supports Slack & Discord URLs)
shellmail webhook -s <url>   # Set webhook URL
shellmail webhook            # View webhook config

# Multi-Inbox Profiles
shellmail profile list       # List all profiles
shellmail profile use work   # Switch to "work" profile
shellmail profile add -n work  # Add a new profile
shellmail profile remove old   # Remove a profile
shellmail -p work inbox      # Use profile for one command
```

## API

Base URL: `https://shellmail.ai`

Authentication: Bearer token (`Authorization: Bearer sm_...`)

### Create Address (no auth)

```bash
curl -X POST https://shellmail.ai/api/addresses \
  -H "Content-Type: application/json" \
  -d '{"local": "my-agent", "recovery_email": "you@email.com"}'
```

```json
{"address": "my-agent@shellmail.ai", "token": "sm_abc123..."}
```

### Get OTP (long-polling) ← the main event

Block until a verification code arrives — up to 30 seconds. Returns immediately when the email lands.

```bash
curl "https://shellmail.ai/api/mail/otp?timeout=30000&from=github.com" \
  -H "Authorization: Bearer sm_abc123..."
```

```json
{"found": true, "code": "123456", "from": "noreply@github.com", "subject": "Your verification code"}
```

Parameters:
- `timeout` — milliseconds to wait (max 30000)
- `from` — filter by sender domain (optional)

If no OTP arrives within the timeout: `{"found": false}`.

### List Emails

```bash
curl https://shellmail.ai/api/mail \
  -H "Authorization: Bearer sm_abc123..."
```

### Search Emails

```bash
curl "https://shellmail.ai/api/mail/search?q=verify&has_otp=true" \
  -H "Authorization: Bearer sm_abc123..."
```

### Send Email

```bash
curl -X POST https://shellmail.ai/api/mail/send \
  -H "Authorization: Bearer sm_abc123..." \
  -H "Content-Type: application/json" \
  -d '{"to": "user@example.com", "subject": "Hello", "body_text": "Hi there!"}'
```

```json
{"ok": true, "id": "email-uuid", "message_id": "<timestamp.uuid@shellmail.ai>"}
```

### Reply to Email (threading)

```bash
curl -X POST https://shellmail.ai/api/mail/send \
  -H "Authorization: Bearer sm_abc123..." \
  -H "Content-Type: application/json" \
  -d '{"to": "user@example.com", "subject": "Re: Hello", "body_text": "Thanks!", "reply_to_id": "original-email-id"}'
```

### List Sent Emails

```bash
curl https://shellmail.ai/api/mail/sent \
  -H "Authorization: Bearer sm_abc123..."
```

### List Threads (conversations)

```bash
curl https://shellmail.ai/api/mail/threads \
  -H "Authorization: Bearer sm_abc123..."
```

### Get Thread (all messages)

```bash
curl https://shellmail.ai/api/mail/threads/{thread_id} \
  -H "Authorization: Bearer sm_abc123..."
```

### Configure Webhook

```bash
# Custom webhook (HMAC-SHA256 signed)
curl -X PUT https://shellmail.ai/api/webhook \
  -H "Authorization: Bearer sm_abc123..." \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-server.com/webhook"}'

# Slack webhook (auto-formatted)
curl -X PUT https://shellmail.ai/api/webhook \
  -H "Authorization: Bearer sm_abc123..." \
  -H "Content-Type: application/json" \
  -d '{"url": "https://hooks.slack.com/services/T.../B.../xxx"}'

# Discord webhook (auto-formatted)
curl -X PUT https://shellmail.ai/api/webhook \
  -H "Authorization: Bearer sm_abc123..." \
  -H "Content-Type: application/json" \
  -d '{"url": "https://discord.com/api/webhooks/123/abc"}'
```

Webhooks are signed with HMAC-SHA256. Verify using the `X-ShellMail-Signature` header.
Slack and Discord URLs are automatically detected and formatted with rich embeds.

### Full API Reference

See [openapi.json](https://shellmail.ai/openapi.json) or [llms.txt](https://shellmail.ai/llms.txt)

## TypeScript SDK

```bash
npm install @shellmail/sdk
```

```typescript
import { ShellMail } from '@shellmail/sdk';

const mail = new ShellMail({ token: 'sm_...' });

// Wait for OTP — blocks up to 30s, returns the code
const { code } = await mail.waitForOtp(30, 'github.com');
// → "847291"

// Check inbox
const inbox = await mail.inbox();

// Send email
await mail.send({
  to: 'user@example.com',
  subject: 'Hello',
  bodyText: 'Hi from my agent!',
});

// Reply to email
await mail.reply('email-id', 'Thanks for your message!');

// View threads (conversations)
const threads = await mail.threads();
const thread = await mail.getThread('thread-id');
```

See [SDK README](sdk/README.md) for full documentation.

## OpenClaw Integration

ShellMail is available on [ClawHub](https://clawhub.ai/aaronbatchelder/shellmail) for instant OpenClaw integration.

### Install via ClawHub

```bash
clawhub install shellmail
```

### Or Manual Install

```bash
cp -r skill/ ~/.openclaw/workspace/skills/shellmail
```

Then set your token:
```bash
gateway config.patch {"skills":{"entries":{"shellmail":{"env":{"SHELLMAIL_TOKEN":"sm_..."}}}}}
```

### Usage

Your agent can now handle email conversationally:

- *"Check my email"*
- *"Get the verification code"*
- *"Wait for the GitHub OTP"*
- *"Send an email to user@example.com saying hello"*
- *"Reply to that email"*

## Claude Code Plugin

ShellMail is available as a Claude Code plugin for seamless integration directly in your coding sessions.

### Install

```bash
claude plugin install https://github.com/aaronbatchelder/shellmail
```

This installs the ShellMail skill into Claude Code. On first use, Claude will walk you through creating an inbox and saving your token.

### Security Considerations

The plugin requires a `SHELLMAIL_TOKEN` that grants full access to your inbox and OTPs. A few things to be aware of:

- **Token persistence** — After setup, the token is saved to agent configuration via `gateway config.patch`, giving Claude persistent inbox access
- **Dedicated inbox** — Use ShellMail for agent tasks only, not personal email
- **Revoke when done** — Remove the token from config when you no longer need the plugin:

```bash
gateway config.patch '{"skills":{"entries":{"shellmail":{"env":{"SHELLMAIL_TOKEN":""}}}}}'
```

Or delete your address entirely to free the name (addresses are held for 14 days, so you can reclaim yours):

```bash
# Via the OpenClaw skill script
./skill/scripts/shellmail.sh delete-account
```

See [.claude-plugin/README.md](.claude-plugin/README.md) for full security guidance.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SHELLMAIL_TOKEN` | Your API token (alternative to config file) |
| `SHELLMAIL_API_URL` | API base URL (default: `https://shellmail.ai`) |

## How It Works

```
Inbound email → Cloudflare Email Routing → Worker → D1 (SQLite)
                                                         ↑
Your agent polls → Cloudflare Worker ────────────────────┘
         or
Webhook POST ← Cloudflare Worker ────────────────────────┘
```

All Cloudflare. Zero servers. Globally distributed. Scales to zero cost.

## Account Recovery & Address Protection

ShellMail is designed so you never lose your preferred address:

- **Address Hold Window** — Deleted addresses are held for 14 days. Re-create with the same recovery email to reclaim your address instantly. After 14 days the name becomes available to anyone.
- **Reclaim Flow** — No need to create a new account. Just `POST /api/addresses` with your original `local` and `recovery_email` to get a fresh token and pick up where you left off.
- **Recovery Audit Log** — Every recovery attempt is logged with machine-readable failure reasons (`address_not_found`, `recovery_email_mismatch`, `resend_not_configured`, `resend_send_failed`). Support can diagnose issues in seconds.
- **Preflight Validation** — Recovery email is validated before the address is claimed. Clear error messages help catch typos before they become permanent.
- **Token Recovery** — `POST /api/recover` sends a new token to your recovery email. The old token is only invalidated after the email is successfully sent.

## Security

- **Token-per-address** — Each address has its own bearer token, isolated from others
- **Hashed storage** — Tokens and recovery emails are SHA-256 hashed, never stored plaintext
- **Recovery via email only** — Lost tokens sent to recovery email, never in API responses
- **Rate limiting** — Recovery endpoint: 3 attempts per address per hour
- **Anti-enumeration** — Recovery responses are identical whether address exists or not
- **Webhook signatures** — HMAC-SHA256 signed payloads

## Data Retention

- **Free tier** — Emails auto-delete after 7 days
- **Shell tier** — 30 days retention
- **Reef tier** — 90 days retention

## Self-Hosting

Want to run your own? ShellMail is open source.

```bash
# Clone
git clone https://github.com/aaronbatchelder/shellmail
cd shellmail

# Install
npm install

# Create D1 database
npx wrangler d1 create shellmail
# Update wrangler.toml with database_id

# Run migrations
npx wrangler d1 migrations apply shellmail --local

# Deploy
npx wrangler deploy
```

Configure Cloudflare Email Routing to forward to your worker.

## Roadmap

What's coming next:

- **Custom domains** — Use `agent@yourdomain.com` instead of `@shellmail.ai`
- **Plan management** — Self-service upgrades and billing
- **Recovery codes** — Backup recovery channel (secondary email / TOTP)
- **Admin rebind tool** — Support action to rebind address with audit trail
- **Attachments** — Send and receive file attachments

Have a feature request? [Open an issue](https://github.com/aaronbatchelder/shellmail/issues).

## Links

- [shellmail.ai](https://shellmail.ai) — Website & docs
- [ClawHub](https://clawhub.ai/aaronbatchelder/shellmail) — OpenClaw skill
- [npm: shellmail](https://www.npmjs.com/package/shellmail) — CLI package
- [npm: shellmail-mcp](https://www.npmjs.com/package/shellmail-mcp) — MCP server
- [Claude Code Plugin](.claude-plugin/README.md) — Plugin for Claude Code
- [OpenAPI](https://shellmail.ai/openapi.json) — API specification
- [llms.txt](https://shellmail.ai/llms.txt) — LLM-friendly docs

## License

MIT
