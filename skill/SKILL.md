---
name: clawmail
description: Check, read, and manage ClawMail inbound email for AI agents. Use when checking email, reading messages, creating email addresses, or managing inbox at clawmail.dev. Trigger on "check mail", "email", "inbox", "clawmail", or any email-related requests.
---

# ClawMail

Inbound email proxy for AI agents. Poll and manage email via REST API.

## Setup

Set in `openclaw.json` under `skills.entries.clawmail`:

```json
{
  "apiUrl": "https://clawmail.ngmaloney.workers.dev",
  "token": "cm_..."
}
```

Or via environment: `CLAWMAIL_TOKEN` and `CLAWMAIL_API_URL`.

## CLI

```bash
{baseDir}/scripts/clawmail.sh <command>
```

Commands:

- `inbox` — list emails (`--unread` for unread only)
- `read <id>` — get full email body
- `mark-read <id>` — mark as read
- `archive <id>` — archive email
- `delete <id>` — delete email
- `create <local> <recovery_email>` — create new address
- `health` — check API status

## Direct API

All authenticated endpoints use `Authorization: Bearer cm_...`

```
GET    /api/mail               — list emails (?unread=true&limit=50)
GET    /api/mail/:id           — full email
PATCH  /api/mail/:id           — update {is_read, is_archived}
DELETE /api/mail/:id           — delete email
POST   /api/addresses          — create {local, recovery_email}
POST   /api/recover            — recover {address, recovery_email}
DELETE /api/addresses/me       — delete address + all mail
```

## Polling Pattern

Check inbox during heartbeats or on a cron:

```bash
CLAWMAIL_TOKEN=cm_... {baseDir}/scripts/clawmail.sh inbox --unread
```

If unread_count > 0, read and summarize new emails for the user.
