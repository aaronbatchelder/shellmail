# @shellmail/sdk

TypeScript SDK for [ShellMail](https://shellmail.ai) - Email for AI agents.

## Installation

```bash
npm install @shellmail/sdk
```

## Quick Start

```typescript
import { ShellMail } from '@shellmail/sdk';

// Create a client
const mail = new ShellMail({ token: 'sm_your_token' });

// Check inbox
const inbox = await mail.inbox();
console.log(`${inbox.unread_count} unread emails`);

// Get latest OTP (with 30s wait)
const otp = await mail.waitForOtp(30, 'github.com');
console.log(`OTP: ${otp}`);

// Send an email
await mail.send({
  to: 'user@example.com',
  subject: 'Hello',
  bodyText: 'Hi from my agent!',
});
```

## Creating an Address

```typescript
import { ShellMail } from '@shellmail/sdk';

// Create a new address (no token needed)
const { address, token } = await ShellMail.createAddress(
  'my-agent',
  'recovery@example.com'
);

console.log(`Created: ${address}`);
console.log(`Token: ${token}`); // Save this!

// Now use it
const mail = new ShellMail({ token });
```

## API Reference

### Constructor

```typescript
const mail = new ShellMail({
  token: 'sm_...',           // Required: Your API token
  baseUrl: 'https://...',    // Optional: API base URL
});
```

### Inbox Methods

```typescript
// List emails
const inbox = await mail.inbox({
  unreadOnly: true,  // Only unread
  limit: 20,         // Max results
  offset: 0,         // Pagination
});

// Get specific email
const email = await mail.getEmail('email-id');

// Mark as read/unread
await mail.markRead('email-id');
await mail.markUnread('email-id');

// Archive
await mail.archive('email-id');

// Delete
await mail.deleteEmail('email-id');
```

### OTP Methods

```typescript
// Get latest OTP
const otp = await mail.getOtp({
  timeout: 30,        // Wait up to 30 seconds
  from: 'github.com', // Filter by sender
  since: '2024-...',  // Only newer than this
});

if (otp.found) {
  console.log(otp.code);  // "123456"
}

// Convenience: wait for OTP
const code = await mail.waitForOtp(30, 'stripe.com');
```

### Search

```typescript
const results = await mail.search({
  q: 'verification',  // Search query
  from: 'github.com', // Filter by sender
  hasOtp: true,       // Only emails with OTPs
  limit: 20,          // Max results
});
```

### Send Methods

```typescript
// Send email
await mail.send({
  to: 'user@example.com',
  subject: 'Hello',
  bodyText: 'Plain text body',
  bodyHtml: '<p>HTML body</p>',  // Optional
  replyToId: 'original-email-id', // Optional, for threading
});

// Reply to an email
await mail.reply('email-id', 'Thanks for your message!');

// List sent emails
const sent = await mail.sent({ limit: 20 });
```

### Webhook Methods

```typescript
// Get webhook config
const config = await mail.getWebhook();

// Set webhook
const { secret } = await mail.setWebhook('https://your-server.com/webhook');

// Remove webhook
await mail.deleteWebhook();
```

### Static Methods

```typescript
// Create address (no auth)
const { address, token } = await ShellMail.createAddress(
  'my-agent',
  'recovery@example.com'
);

// Recover token
await ShellMail.recoverToken(
  'my-agent@shellmail.ai',
  'recovery@example.com'
);

// Health check
const health = await ShellMail.health();
```

## Error Handling

```typescript
import { ShellMail, ShellMailError } from '@shellmail/sdk';

try {
  await mail.send({ ... });
} catch (error) {
  if (error instanceof ShellMailError) {
    console.log(error.message);  // Error message
    console.log(error.status);   // HTTP status code
  }
}
```

## Environment Variables

The SDK reads these if not provided in config:

- `SHELLMAIL_TOKEN` - Your API token
- `SHELLMAIL_API_URL` - API base URL (default: https://shellmail.ai)

## Links

- [ShellMail Website](https://shellmail.ai)
- [API Documentation](https://shellmail.ai/llms.txt)
- [GitHub](https://github.com/aaronbatchelder/shellmail)

## License

MIT
