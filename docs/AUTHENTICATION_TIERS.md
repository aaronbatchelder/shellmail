# Authentication Tiers - Implementation Plan

## Overview

Matches AgentMail's authentication model: addresses default to 10 emails/day, higher limits require human authentication to prevent spam/abuse.

## Tier Structure

| Tier | Daily Limit | Authentication Required | Cost |
|------|-------------|------------------------|------|
| Free (Unauth) | 10 emails/day | None (default for agents) | Free |
| Shell (Auth) | 50 emails/day | Recovery email OR OAuth | Free |
| Reef (Paid) | 100 emails/day | Payment method | $8/month |

## Authentication Methods

### 1. Recovery Email Verification (Free Upgrade: Free → Shell)

**Flow:**
1. User creates address with recovery email
2. To unlock 50/day, user verifies recovery email ownership
3. API sends OTP code to recovery email
4. User submits OTP code
5. System verifies code, sets `recovery_verified=1`, upgrades `plan='shell'`

**Benefits:**
- Proves human control (bots can't read external email)
- Uses existing recovery email (no new data collection)
- Free for legitimate users
- Raises cost for spammers (need real email addresses)

**API Endpoints:**
```
POST /api/auth/verify-recovery/request
  → Sends OTP to recovery email on file
  → Returns: { "ok": true, "expires_in": 300 }

POST /api/auth/verify-recovery/confirm
  Body: { "code": "123456" }
  → Verifies OTP code
  → Upgrades plan to 'shell'
  → Returns: { "ok": true, "plan": "shell", "daily_limit": 50 }
```

### 2. OAuth Authentication (Free Upgrade: Free → Shell)

**Providers:** Google, GitHub

**Flow:**
1. User initiates OAuth flow via CLI or web
2. Redirects to OAuth provider (Google/GitHub)
3. User authorizes ShellMail to read email/profile
4. Callback receives OAuth token
5. System stores `oauth_provider`, `oauth_id`, sets `authenticated_at`, upgrades to shell

**Benefits:**
- Strong identity verification
- No additional email needed
- Industry standard security
- Prevents disposable accounts

**API Endpoints:**
```
GET /api/auth/oauth/google
  → Redirects to Google OAuth consent screen

GET /api/auth/oauth/github
  → Redirects to GitHub OAuth consent screen

GET /api/auth/oauth/callback
  Query: ?code=...&state=...&provider=google|github
  → Exchanges code for token
  → Upgrades plan to 'shell'
  → Returns: { "ok": true, "plan": "shell", "provider": "google" }
```

### 3. Payment Method (Paid Upgrade: Any → Reef)

**Flow:**
1. User adds payment method via Stripe
2. Creates subscription to Reef plan ($8/month)
3. Webhook confirms payment
4. System sets `stripe_customer_id`, upgrades `plan='reef'`

**Benefits:**
- Strongest spam deterrent (costs money)
- Revenue generation
- Credit card verification = identity verification

**API Endpoints:**
```
POST /api/billing/checkout
  → Creates Stripe checkout session
  → Returns: { "checkout_url": "https://checkout.stripe.com/..." }

POST /api/webhooks/stripe
  → Handles subscription events
  → Upgrades/downgrades plan based on subscription status
```

## Database Schema (Already in Migration)

```sql
-- addresses table columns (already added in 0010_anti_spam.sql)
recovery_verified INTEGER NOT NULL DEFAULT 0
oauth_provider TEXT
oauth_id TEXT
authenticated_at TEXT
```

**New table needed:**
```sql
CREATE TABLE verification_codes (
  id TEXT PRIMARY KEY,
  address_id TEXT NOT NULL,
  code TEXT NOT NULL,
  purpose TEXT NOT NULL, -- 'recovery_verification'
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (address_id) REFERENCES addresses(id)
);

CREATE INDEX idx_verification_address ON verification_codes(address_id);
CREATE INDEX idx_verification_code ON verification_codes(code);
CREATE INDEX idx_verification_expires ON verification_codes(expires_at);
```

## Implementation

### Phase 1: Recovery Email Verification (Priority)

**Files to create:**
- `src/auth/verify.ts` - OTP generation, email sending, verification logic
- `src/auth/upgrade.ts` - Plan upgrade logic

**Files to modify:**
- `src/api.ts` - Add verification endpoints
- `migrations/0011_verification.sql` - Add verification_codes table

**Send limit logic:**
```typescript
function getEffectiveSendLimit(addr: Address): number {
  const baseLimits = { free: 10, shell: 50, reef: 100 };

  // Default to plan limit
  let limit = baseLimits[addr.plan] || baseLimits.free;

  // If on free plan but authenticated, upgrade to shell limits
  if (addr.plan === 'free' && (addr.recovery_verified || addr.oauth_provider)) {
    limit = baseLimits.shell;
  }

  return limit;
}
```

### Phase 2: OAuth Authentication

**Dependencies:**
- OAuth client library for Workers (use native fetch)
- Google OAuth credentials (client_id, client_secret)
- GitHub OAuth credentials

**Environment variables:**
```
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET
GITHUB_OAUTH_CLIENT_ID
GITHUB_OAUTH_CLIENT_SECRET
OAUTH_REDIRECT_URI=https://shellmail.ai/api/auth/oauth/callback
```

### Phase 3: Payment Integration (Future)

**Dependencies:**
- Stripe API integration
- Subscription webhooks
- Billing portal

## CLI Commands

**Verify recovery email:**
```bash
shellmail auth verify-recovery
# Sends OTP to recovery email on file
# Prompts for code
# Confirms and shows new limit
```

**OAuth authentication:**
```bash
shellmail auth oauth google
# Opens browser to Google OAuth
# Polls for completion
# Shows new limit

shellmail auth oauth github
# Same for GitHub
```

**Check authentication status:**
```bash
shellmail auth status
# Shows:
# - Current plan
# - Daily limit
# - Authentication method (none, recovery, google, github, stripe)
# - Authenticated at timestamp
```

## Success Metrics

**After Phase 1 (Recovery Verification):**
- >50% of active users verify recovery email within 7 days
- Spam/abuse rate decreases by >70%
- False positive rate <5% (legitimate users blocked)

**After Phase 2 (OAuth):**
- >20% of users choose OAuth over recovery email
- Zero OAuth-authenticated accounts suspended for spam

## Security Considerations

### OTP Security
- 6-digit codes (1,000,000 combinations)
- 5-minute expiration
- Rate limit: 3 requests per hour per address
- Single-use codes (mark as `used=1`)

### OAuth Security
- State parameter prevents CSRF
- Store OAuth tokens encrypted (not needed - just use for verification)
- Validate OAuth token with provider before trusting

### Abuse Prevention
- Can't downgrade from authenticated to unauthenticated
- Revoking authentication suspends address if over free tier limit
- Track authentication changes in audit log

## Rollout Plan

**Week 1:** Deploy Phase 1 (Recovery Verification)
- Add verification endpoints
- Update CLI
- Announce to users (optional upgrade)

**Week 2:** Monitor metrics
- Track verification rate
- Monitor spam/abuse changes
- Tune rate limits if needed

**Week 3:** Deploy Phase 2 (OAuth)
- Add OAuth flows
- Update CLI
- Announce as alternative to recovery verification

**Week 4:** Evaluate results
- Compare spam rates before/after
- User feedback
- Decide on payment tier implementation

## Comparison to AgentMail

| Feature | AgentMail | ShellMail |
|---------|-----------|-----------|
| Default limit | 10/day | 10/day ✅ |
| Auth required for higher | Yes | Yes ✅ |
| Auth methods | Unspecified "person" | Recovery email + OAuth + Payment ✅ |
| Free tier post-auth | Unknown | 50/day (Shell) ✅ |
| Paid tier | $20/month | $8/month (Reef) ✅ Better |

**Key advantages over AgentMail:**
- More authentication options (recovery, OAuth, payment)
- Clear pricing tiers ($8 vs $20)
- Free authenticated tier (50/day) bridges gap
- Open about authentication methods
