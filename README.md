# 📧 ClawMail

Email proxy for AI agents. Create custom email addresses, receive mail, poll from your agent.

## How It Works

1. **Create an address** → `POST /api/addresses` → get a bearer token
2. **Receive email** → Cloudflare Email Workers catch inbound mail, store in D1
3. **Poll from your agent** → `GET /api/mail` with your bearer token

No user accounts. One token per address. Simple.

## Quick Start

### Prerequisites

- Cloudflare account with a domain
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

### Setup

```bash
# Install deps
npm install

# Create D1 database
npx wrangler d1 create clawmail

# Update wrangler.toml with the database_id from above

# Run migrations
npx wrangler d1 execute clawmail --file=migrations/0001_init.sql

# Deploy
npx wrangler deploy
```

### Configure Email Routing

1. In Cloudflare dashboard, go to your domain → Email Routing
2. Add a catch-all rule that routes to the ClawMail worker

## API

### Public Endpoints (no auth)

**Create address:**
```bash
curl -X POST https://clawmail.YOUR_DOMAIN/api/addresses \
  -H "Content-Type: application/json" \
  -d '{"local": "pinchy", "recovery_email": "you@gmail.com"}'
# → {"address": "pinchy@clawmail.dev", "token": "cm_abc123..."}
```

**Recover token:**
```bash
curl -X POST https://clawmail.YOUR_DOMAIN/api/recover \
  -H "Content-Type: application/json" \
  -d '{"address": "pinchy@clawmail.dev", "recovery_email": "you@gmail.com"}'
```

### Authenticated Endpoints (Bearer token)

**List mail:**
```bash
curl https://clawmail.YOUR_DOMAIN/api/mail \
  -H "Authorization: Bearer cm_abc123..."
```

**Get email:**
```bash
curl https://clawmail.YOUR_DOMAIN/api/mail/{id} \
  -H "Authorization: Bearer cm_abc123..."
```

**Mark read:**
```bash
curl -X PATCH https://clawmail.YOUR_DOMAIN/api/mail/{id} \
  -H "Authorization: Bearer cm_abc123..." \
  -H "Content-Type: application/json" \
  -d '{"is_read": true}'
```

**Delete email:**
```bash
curl -X DELETE https://clawmail.YOUR_DOMAIN/api/mail/{id} \
  -H "Authorization: Bearer cm_abc123..."
```

**Delete address (and all mail):**
```bash
curl -X DELETE https://clawmail.YOUR_DOMAIN/api/addresses/me \
  -H "Authorization: Bearer cm_abc123..."
```

## Architecture

```
Inbound email → Cloudflare Email Worker → D1 (storage)
                                              ↑
Agent polls → Cloudflare API Worker ──────────┘
```

All Cloudflare. Zero servers. Scales to zero cost at low volume.

## License

MIT
