# Anti-Spam Implementation Plan

## Executive Summary

ShellMail needs comprehensive anti-spam safeguards before scaling to prevent abuse of the agent self-provisioning API. This document outlines a multi-layered approach to spam prevention that matches or exceeds competitor safeguards.

**Priority**: Critical - must implement before marketing/scaling
**Timeline**: Phase 1 (core safeguards) before any paid launch

## Problem Statement

ShellMail's `/api/addresses` endpoint allows AI agents to create email addresses without authentication. While this is a competitive advantage (shipped before AgentMail announced similar feature), it creates abuse potential:

- Agents could create unlimited addresses for spam
- No bounce rate monitoring to detect delivery issues
- No content filtering for malicious/spam content
- No pattern detection for unusual sending behavior
- No authentication requirement for higher send volumes

## Competitor Comparison

### AgentMail Safeguards
- 10 emails/day limit unless authenticated by person
- Rate limits on unusual activity
- Bounce rate monitoring
- Random sampling with keyword filtering

### Our Current State
✅ Basic rate limiting (10/50/100 per day by plan)
✅ Address creation limits (5/hour per IP, 10/day per recovery email)
❌ No bounce tracking
❌ No content filtering
❌ No pattern detection
❌ No authentication requirements for higher limits

## Proposed Solution: Multi-Layer Defense

### Layer 1: Enhanced Rate Limiting (Already Partially Implemented)
**Current**: Daily send limits by plan (10/50/100)
**Add**:
- Burst limits (max 5 emails in 1 minute)
- Recipient diversity tracking (flag if same recipient gets >3 emails/day)
- IP-based throttling (max 50 sends/day per IP across all addresses)

### Layer 2: Bounce Rate Monitoring (New)
**Track**:
- Hard bounces (invalid addresses)
- Soft bounces (temporary failures)
- Complaint rates (spam reports)

**Actions**:
- Suspend address if bounce rate >20% over 10 emails
- Warn if bounce rate 10-20%
- Auto-suspend if complaint rate >1%

### Layer 3: Content Filtering (New)
**Scan outbound emails for**:
- Spam keywords (crypto, pharma, adult content patterns)
- Malicious URLs (phishing domains, URL shorteners in bulk)
- Suspicious patterns (all-caps subject lines, excessive links)

**Implementation**:
- Lightweight regex-based filtering for common spam patterns
- Domain reputation checks via DNS blacklists
- Auto-reject if confidence score >80%, flag for review if 50-80%

### Layer 4: Behavioral Pattern Detection (New)
**Monitor for**:
- Rapid address creation from same IP (>5 in 1 hour)
- Unusual sending times (bulk sends at 3am)
- Recipient list patterns (sequential emails to scraped lists)
- High volume from new addresses (<24 hours old)

**Actions**:
- Auto-flag accounts for manual review
- Temporary rate limit reduction
- Require human authentication to restore full limits

### Layer 5: Authentication Requirements (New)
**Free Tier**:
- 10 emails/day default
- To unlock 50/day: verify recovery email via OTP
- To unlock 100/day: connect OAuth (Google/GitHub) or payment method

**Paid Tiers**:
- Stripe payment = automatic authentication
- Higher limits require verified payment method

## Database Schema Changes

### New Table: `bounce_tracking`
```sql
CREATE TABLE bounce_tracking (
  id TEXT PRIMARY KEY,
  address_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  bounce_type TEXT NOT NULL, -- 'hard', 'soft', 'complaint'
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (address_id) REFERENCES addresses(id)
);

CREATE INDEX idx_bounce_address ON bounce_tracking(address_id);
CREATE INDEX idx_bounce_created ON bounce_tracking(created_at);
```

### New Table: `abuse_log`
```sql
CREATE TABLE abuse_log (
  id TEXT PRIMARY KEY,
  address_id TEXT NOT NULL,
  ip_address TEXT,
  abuse_type TEXT NOT NULL, -- 'content_filter', 'pattern_detection', 'rate_limit', 'bounce_rate'
  severity TEXT NOT NULL, -- 'low', 'medium', 'high', 'critical'
  details TEXT,
  action_taken TEXT, -- 'flagged', 'rate_limited', 'suspended', 'none'
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (address_id) REFERENCES addresses(id)
);

CREATE INDEX idx_abuse_address ON abuse_log(address_id);
CREATE INDEX idx_abuse_severity ON abuse_log(severity);
CREATE INDEX idx_abuse_created ON abuse_log(created_at);
```

### New Table: `content_filters`
```sql
CREATE TABLE content_filters (
  id TEXT PRIMARY KEY,
  pattern_type TEXT NOT NULL, -- 'keyword', 'regex', 'domain', 'url_pattern'
  pattern TEXT NOT NULL,
  severity INTEGER NOT NULL, -- 1-100 score
  description TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Pre-populate with common spam patterns
INSERT INTO content_filters (id, pattern_type, pattern, severity, description) VALUES
  ('cf_crypto_1', 'keyword', '(?i)(bitcoin|crypto|nft|web3).*invest', 75, 'Crypto investment spam'),
  ('cf_pharma_1', 'keyword', '(?i)(viagra|cialis|pharmacy)', 80, 'Pharmaceutical spam'),
  ('cf_urgent_1', 'regex', '(?i)urgent.*act now', 60, 'Urgency manipulation'),
  ('cf_allcaps_1', 'pattern', 'SUBJECT_ALL_CAPS', 50, 'All-caps subject line');
```

### Modify Existing Tables

**addresses table** - add authentication columns:
```sql
ALTER TABLE addresses ADD COLUMN recovery_verified INTEGER DEFAULT 0;
ALTER TABLE addresses ADD COLUMN oauth_provider TEXT;
ALTER TABLE addresses ADD COLUMN oauth_id TEXT;
ALTER TABLE addresses ADD COLUMN authenticated_at TEXT;
ALTER TABLE addresses ADD COLUMN bounce_rate_30d REAL DEFAULT 0.0;
ALTER TABLE addresses ADD COLUMN suspended INTEGER DEFAULT 0;
ALTER TABLE addresses ADD COLUMN suspension_reason TEXT;
```

**send_log table** - add tracking columns:
```sql
ALTER TABLE send_log ADD COLUMN bounce_type TEXT;
ALTER TABLE send_log ADD COLUMN content_scan_score INTEGER;
ALTER TABLE send_log ADD COLUMN flagged INTEGER DEFAULT 0;
```

## Code Implementation

### 1. Bounce Tracking Service (`src/bounce.ts`)

```typescript
import { Env, BounceType } from './types';

export async function recordBounce(
  env: Env,
  addressId: string,
  recipient: string,
  bounceType: BounceType,
  reason: string
) {
  // Record bounce
  await env.DB.prepare(
    `INSERT INTO bounce_tracking (id, address_id, recipient, bounce_type, reason)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), addressId, recipient, bounceType, reason).run();

  // Calculate bounce rate (last 30 days)
  const stats = await env.DB.prepare(
    `SELECT
       COUNT(*) as total_sends,
       SUM(CASE WHEN bounce_type IN ('hard', 'complaint') THEN 1 ELSE 0 END) as hard_bounces
     FROM send_log
     WHERE address_id = ?
       AND created_at > datetime('now', '-30 days')`
  ).bind(addressId).first();

  const bounceRate = stats.total_sends > 0
    ? (stats.hard_bounces / stats.total_sends)
    : 0.0;

  // Update address bounce rate
  await env.DB.prepare(
    `UPDATE addresses SET bounce_rate_30d = ? WHERE id = ?`
  ).bind(bounceRate, addressId).run();

  // Auto-suspend if bounce rate too high
  if (bounceRate > 0.20 && stats.total_sends >= 10) {
    await suspendAddress(env, addressId, 'bounce_rate_exceeded', bounceRate);
  }

  return { bounceRate, totalSends: stats.total_sends };
}

async function suspendAddress(
  env: Env,
  addressId: string,
  reason: string,
  bounceRate: number
) {
  await env.DB.prepare(
    `UPDATE addresses
     SET suspended = 1, suspension_reason = ?
     WHERE id = ?`
  ).bind(`${reason} (bounce rate: ${(bounceRate * 100).toFixed(1)}%)`, addressId).run();

  // Log abuse
  await env.DB.prepare(
    `INSERT INTO abuse_log (id, address_id, abuse_type, severity, details, action_taken)
     VALUES (?, ?, 'bounce_rate', 'high', ?, 'suspended')`
  ).bind(
    crypto.randomUUID(),
    addressId,
    `Bounce rate ${(bounceRate * 100).toFixed(1)}% exceeded threshold`
  ).run();
}
```

### 2. Content Filtering Service (`src/content-filter.ts`)

```typescript
import { Env } from './types';

interface FilterResult {
  passed: boolean;
  score: number;
  matches: string[];
  action: 'allow' | 'flag' | 'reject';
}

export async function scanContent(
  env: Env,
  subject: string,
  body: string,
  to: string[]
): Promise<FilterResult> {
  const filters = await env.DB.prepare(
    `SELECT pattern_type, pattern, severity
     FROM content_filters
     WHERE enabled = 1`
  ).all();

  let totalScore = 0;
  const matches: string[] = [];

  for (const filter of filters.results) {
    let matched = false;

    switch (filter.pattern_type) {
      case 'keyword':
      case 'regex':
        const regex = new RegExp(filter.pattern);
        if (regex.test(subject) || regex.test(body)) {
          matched = true;
        }
        break;

      case 'pattern':
        if (filter.pattern === 'SUBJECT_ALL_CAPS' && subject === subject.toUpperCase()) {
          matched = true;
        }
        break;
    }

    if (matched) {
      totalScore += filter.severity;
      matches.push(filter.pattern);
    }
  }

  // Check for excessive links
  const linkCount = (body.match(/https?:\/\//g) || []).length;
  if (linkCount > 5) {
    totalScore += 40;
    matches.push('excessive_links');
  }

  // Determine action
  let action: 'allow' | 'flag' | 'reject';
  if (totalScore >= 80) {
    action = 'reject';
  } else if (totalScore >= 50) {
    action = 'flag';
  } else {
    action = 'allow';
  }

  return {
    passed: action === 'allow',
    score: totalScore,
    matches,
    action
  };
}
```

### 3. Pattern Detection Service (`src/patterns.ts`)

```typescript
import { Env } from './types';

export async function detectAbusePatterns(
  env: Env,
  addressId: string,
  ipAddress: string
): Promise<{ suspicious: boolean; reasons: string[] }> {
  const reasons: string[] = [];

  // Check 1: Rapid address creation from same IP
  const recentAddresses = await env.DB.prepare(
    `SELECT COUNT(*) as count
     FROM addresses
     WHERE ip_address = ?
       AND created_at > datetime('now', '-1 hour')`
  ).bind(ipAddress).first();

  if (recentAddresses.count > 5) {
    reasons.push('rapid_address_creation');
  }

  // Check 2: High volume from new address
  const addressAge = await env.DB.prepare(
    `SELECT
       (julianday('now') - julianday(created_at)) * 24 as age_hours,
       (SELECT COUNT(*) FROM send_log WHERE address_id = addresses.id) as sends
     FROM addresses
     WHERE id = ?`
  ).bind(addressId).first();

  if (addressAge.age_hours < 24 && addressAge.sends > 20) {
    reasons.push('high_volume_new_address');
  }

  // Check 3: Unusual sending time (bulk sends between midnight-6am)
  const nightSends = await env.DB.prepare(
    `SELECT COUNT(*) as count
     FROM send_log
     WHERE address_id = ?
       AND cast(strftime('%H', created_at) as integer) BETWEEN 0 AND 6
       AND created_at > datetime('now', '-24 hours')`
  ).bind(addressId).first();

  if (nightSends.count > 10) {
    reasons.push('unusual_sending_hours');
  }

  // Check 4: Same recipient receiving multiple emails
  const recipientPattern = await env.DB.prepare(
    `SELECT recipient_email, COUNT(*) as count
     FROM send_log
     WHERE address_id = ?
       AND created_at > datetime('now', '-24 hours')
     GROUP BY recipient_email
     HAVING count > 3`
  ).bind(addressId).first();

  if (recipientPattern) {
    reasons.push('recipient_targeting');
  }

  return {
    suspicious: reasons.length > 0,
    reasons
  };
}
```

### 4. Modify `src/api.ts` - Update `sendMail` function

**Insert at start of sendMail function (around line 530)**:

```typescript
// Check if address is suspended
if (addr.suspended) {
  return jsonError(403, 'Address suspended: ' + (addr.suspension_reason || 'abuse detected'));
}

// Content filtering
const contentScan = await scanContent(env, subject, body, to);
if (contentScan.action === 'reject') {
  await env.DB.prepare(
    `INSERT INTO abuse_log (id, address_id, abuse_type, severity, details, action_taken)
     VALUES (?, ?, 'content_filter', 'high', ?, 'rejected')`
  ).bind(
    crypto.randomUUID(),
    addr.id,
    `Spam score: ${contentScan.score}, matches: ${contentScan.matches.join(', ')}`
  ).run();

  return jsonError(403, 'Message rejected: content policy violation');
}

// Pattern detection
const patterns = await detectAbusePatterns(env, addr.id, request.headers.get('CF-Connecting-IP'));
if (patterns.suspicious) {
  await env.DB.prepare(
    `INSERT INTO abuse_log (id, address_id, ip_address, abuse_type, severity, details, action_taken)
     VALUES (?, ?, ?, 'pattern_detection', 'medium', ?, 'flagged')`
  ).bind(
    crypto.randomUUID(),
    addr.id,
    request.headers.get('CF-Connecting-IP'),
    `Patterns detected: ${patterns.reasons.join(', ')}`
  ).run();
}

// Burst rate limiting (max 5 in 1 minute)
const recentSends = await env.DB.prepare(
  `SELECT COUNT(*) as count
   FROM send_log
   WHERE address_id = ?
     AND created_at > datetime('now', '-1 minute')`
).bind(addr.id).first();

if (recentSends.count >= 5) {
  return jsonError(429, 'Rate limit exceeded: max 5 emails per minute');
}
```

### 5. Create Resend Webhook Handler (`src/webhooks/resend.ts`)

```typescript
import { Env } from '../types';
import { recordBounce } from '../bounce';

export async function handleResendWebhook(request: Request, env: Env) {
  const body = await request.json();

  // Verify webhook signature (Resend provides this)
  const signature = request.headers.get('resend-signature');
  // TODO: Implement signature verification

  switch (body.type) {
    case 'email.bounced':
      await recordBounce(
        env,
        body.data.tags.address_id, // We'll add this tag when sending
        body.data.to,
        'hard',
        body.data.bounce_reason
      );
      break;

    case 'email.complained':
      await recordBounce(
        env,
        body.data.tags.address_id,
        body.data.to,
        'complaint',
        'spam report'
      );
      break;

    case 'email.delivery_delayed':
      await recordBounce(
        env,
        body.data.tags.address_id,
        body.data.to,
        'soft',
        body.data.delay_reason
      );
      break;
  }

  return new Response('OK', { status: 200 });
}
```

## Implementation Phases

### Phase 1: Critical Safeguards (Week 1)
**Goal**: Prevent immediate abuse, stop obvious spam

1. ✅ Create database migration for new tables
2. ✅ Implement content filtering service
3. ✅ Add suspension checks to sendMail
4. ✅ Add burst rate limiting
5. ✅ Create Resend webhook handler
6. ⬜ Deploy migration to production
7. ⬜ Configure Resend webhook URL
8. ⬜ Test with sandbox accounts

**Success Metrics**:
- Content filter catches test spam emails
- Bounce webhooks properly record events
- Burst limits prevent rapid sending

### Phase 2: Pattern Detection (Week 2)
**Goal**: Identify suspicious behavior patterns

1. ⬜ Implement pattern detection service
2. ⬜ Add IP tracking to address creation
3. ⬜ Create abuse log review dashboard
4. ⬜ Set up alerts for high-severity abuse events
5. ⬜ Test with simulated abuse scenarios

**Success Metrics**:
- Rapid address creation flagged
- Unusual send patterns detected
- Admin can review flagged accounts

### Phase 3: Authentication Requirements (Week 3)
**Goal**: Enable higher limits for verified users

1. ⬜ Add recovery email OTP verification
2. ⬜ Implement OAuth integration (Google/GitHub)
3. ⬜ Create authentication API endpoints
4. ⬜ Update CLI with auth commands
5. ⬜ Update documentation

**Success Metrics**:
- Users can verify recovery email
- OAuth flow completes successfully
- Authenticated users get higher limits

### Phase 4: Advanced Monitoring (Week 4)
**Goal**: Continuous improvement and adaptation

1. ⬜ Build admin dashboard for abuse metrics
2. ⬜ Implement appeal/review process
3. ⬜ Add machine learning scoring (future)
4. ⬜ Create automated filter tuning

## Testing Strategy

### Unit Tests
- Content filter pattern matching
- Bounce rate calculation
- Pattern detection logic
- Rate limiting edge cases

### Integration Tests
- Webhook handling end-to-end
- Suspension workflow
- Authentication flow
- Appeal process

### Load Tests
- 1000 addresses created in 1 hour (should flag IP)
- 100 emails sent in 1 minute (should burst limit)
- Spam content in 50 variations (should catch most)

### Penetration Tests
- Attempt bypass via VPN rotation
- Header spoofing
- Content obfuscation techniques
- Rapid account cycling

## Monitoring & Alerts

### Dashboards
1. **Abuse Overview**
   - Total flagged accounts (24h, 7d, 30d)
   - Suspension rate by reason
   - Top spam patterns detected
   - Bounce rate trends

2. **Content Filter Performance**
   - Messages scanned vs. flagged vs. rejected
   - False positive rate (user appeals)
   - Pattern effectiveness scores

3. **System Health**
   - API latency impact from scanning
   - Database query performance
   - Webhook processing lag

### Alerts
- Slack notification when account suspended
- Email alert for >10 abuse events in 1 hour
- PagerDuty for critical system failures

## Success Criteria

### Before Launch
- ✅ All Phase 1 safeguards deployed
- ✅ Zero test spam emails delivered
- ✅ Bounce tracking working with Resend
- ✅ Content filters tuned (false positive <5%)

### Post-Launch Metrics
- Suspension rate <1% of active users
- Bounce rate across platform <5%
- Complaint rate <0.1%
- False positive rate on content filters <2%

### Competitive Parity
- ✅ Match AgentMail's safeguards (10/day default limit)
- ✅ Exceed with authentication tiers (OTP/OAuth)
- ✅ More transparent abuse policies
- ✅ Faster appeal process

## Future Enhancements

### Machine Learning
- Train model on flagged content for better detection
- Anomaly detection for sending patterns
- Reputation scoring system

### Allowlists/Blocklists
- User-managed sender allowlists
- Global domain blocklist (known spam domains)
- IP reputation integration (Spamhaus, etc.)

### Advanced Features
- DMARC/SPF/DKIM verification for custom domains
- Sender reputation API for other services
- Real-time threat intelligence feeds

## Cost Analysis

### Minimal Cost Impact
- Content filtering: regex-based, ~1ms per email
- Pattern detection: DB queries, <10ms per send
- Bounce tracking: webhook processing, <5ms per event

### Database Growth
- abuse_log: ~100 rows/day = 36k/year (~5MB)
- bounce_tracking: ~50 rows/day = 18k/year (~2MB)
- content_filters: ~50 static rows (~10KB)

**Total annual storage**: <10MB additional
**Performance impact**: <15ms added latency per send

## Rollback Plan

If abuse safeguards cause issues:

1. **Phase 1 rollback**: Disable content filtering via feature flag
2. **Phase 2 rollback**: Disable pattern detection alerts
3. **Phase 3 rollback**: Revert authentication requirements

**Feature flags in env**:
```
ENABLE_CONTENT_FILTERING=true
ENABLE_PATTERN_DETECTION=true
ENABLE_AUTH_REQUIREMENTS=true
```

## Conclusion

This anti-spam implementation provides comprehensive protection against abuse while maintaining ShellMail's competitive advantage of agent self-provisioning. The phased approach allows for iterative testing and refinement before full rollout.

**Next Steps**:
1. Review and approve this plan
2. Create database migration files
3. Begin Phase 1 implementation
4. Schedule security review before production deployment
