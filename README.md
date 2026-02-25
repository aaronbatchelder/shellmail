<p align="center">
  <img src="public/logo.png" alt="ShellMail" width="180" style="border-radius: 24px;">
</p>

<h1 align="center">ShellMail</h1>

<p align="center">
  <strong>Email for AI agents.</strong><br>
  Give your agent an inbox in under 60 seconds. No servers. No config. Just email that works.
</p>

<p align="center">
  <a href="https://shellmail.ai">Website</a> •
  <a href="https://clawhub.ai/aaronbatchelder/shellmail">ClawHub</a> •
  <a href="https://www.npmjs.com/package/shellmail">npm</a> •
  <a href="https://shellmail.ai/openapi.json">OpenAPI</a>
</p>

---

## Quick Start

**For everyone** — Create an inbox and start receiving email:

```bash
npx shellmail setup
```

**For OpenClaw users** — Install the skill, then your agent can check email conversationally:

```bash
clawhub install shellmail
```

That's it. You now have `yourname@shellmail.ai` ready to receive mail.

## Why ShellMail?

Your AI agent needs to verify accounts, receive notifications, and get OTP codes. But email is complex—SMTP, IMAP, spam filters, server management.

ShellMail is email reduced to a REST API:

- **Create address** → Get a token
- **Receive mail** → We store it
- **Poll or webhook** → Your agent gets it

No servers. No SMTP. No complexity.

## Features

- **OTP Extraction** — Verification codes are automatically extracted from emails
- **Long Polling** — Wait up to 30s for an OTP to arrive: `GET /api/mail/otp?timeout=30000`
- **Webhooks** — Get instant notifications when mail arrives (HMAC-SHA256 signed)
- **Search** — Find emails by sender, content, or OTP presence
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
shellmail setup              # Create new address interactively
shellmail inbox              # List emails
shellmail inbox -u           # List unread only
shellmail read <id>          # Read specific email
shellmail otp                # Get latest OTP code
shellmail otp -w 30          # Wait up to 30s for OTP
shellmail otp -f github.com  # Filter by sender
shellmail search --otp       # Find emails with OTPs
shellmail search -q "verify" # Search by keyword
shellmail webhook -s <url>   # Set webhook URL
shellmail webhook            # View webhook config
shellmail status             # Check service status
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

### List Emails

```bash
curl https://shellmail.ai/api/mail \
  -H "Authorization: Bearer sm_abc123..."
```

### Get Latest OTP (with long-polling)

```bash
# Wait up to 30 seconds for an OTP from GitHub
curl "https://shellmail.ai/api/mail/otp?timeout=30000&from=github.com" \
  -H "Authorization: Bearer sm_abc123..."
```

```json
{"found": true, "code": "123456", "from": "noreply@github.com", "subject": "Your verification code"}
```

### Search Emails

```bash
curl "https://shellmail.ai/api/mail/search?q=verify&has_otp=true" \
  -H "Authorization: Bearer sm_abc123..."
```

### Configure Webhook

```bash
curl -X PUT https://shellmail.ai/api/webhook \
  -H "Authorization: Bearer sm_abc123..." \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-server.com/webhook"}'
```

Webhooks are signed with HMAC-SHA256. Verify using the `X-ShellMail-Signature` header.

### Full API Reference

See [openapi.json](https://shellmail.ai/openapi.json) or [llms.txt](https://shellmail.ai/llms.txt)

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

Your agent can now check email conversationally:

- *"Check my email"*
- *"Get the verification code"*
- *"Wait for the GitHub OTP"*

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

- **Sending** — Send emails from your agent, not just receive
- **Multi-inbox management** — Switch between inboxes with `--profile work|personal`
- **Custom domains** — Use `agent@yourdomain.com` instead of `@shellmail.ai`
- **Storage tiers** — Configurable retention limits and message quotas
- **Plan management** — Self-service upgrades and billing

Have a feature request? [Open an issue](https://github.com/aaronbatchelder/shellmail/issues).

## Links

- [shellmail.ai](https://shellmail.ai) — Website & docs
- [ClawHub](https://clawhub.ai/aaronbatchelder/shellmail) — OpenClaw skill
- [npm](https://www.npmjs.com/package/shellmail) — CLI package
- [OpenAPI](https://shellmail.ai/openapi.json) — API specification
- [llms.txt](https://shellmail.ai/llms.txt) — LLM-friendly docs

## License

MIT
