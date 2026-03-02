# ShellMail MCP Server

MCP (Model Context Protocol) server for [ShellMail](https://shellmail.ai) - Email for AI agents.

This server allows Claude Desktop, Cursor, Cline, and other MCP-compatible clients to send and receive email through ShellMail.

## Installation

### Claude Desktop

Add to your `claude_desktop_config.json`:

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

Config file location:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

### Get Your Token

```bash
npx shellmail setup
```

Or create an address via API:
```bash
curl -X POST https://shellmail.ai/api/addresses \
  -H "Content-Type: application/json" \
  -d '{"local":"my-agent","recovery_email":"you@email.com"}'
```

## Available Tools

| Tool | Description |
|------|-------------|
| `shellmail_inbox` | List emails in inbox |
| `shellmail_read` | Read full email content |
| `shellmail_otp` | Get latest OTP code (with long-polling) |
| `shellmail_send` | Send an email |
| `shellmail_search` | Search emails |
| `shellmail_sent` | List sent emails |
| `shellmail_delete` | Delete an email |
| `shellmail_mark_read` | Mark email as read |

## Example Usage

Once configured, you can ask Claude:

- "Check my email"
- "Get the verification code from GitHub"
- "Wait for an OTP from Stripe"
- "Send an email to user@example.com saying hello"
- "Search for emails about invoices"

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SHELLMAIL_TOKEN` | Your ShellMail API token (required) |
| `SHELLMAIL_API_URL` | API base URL (default: `https://shellmail.ai`) |

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run locally
SHELLMAIL_TOKEN=sm_xxx node dist/index.js
```

## Links

- [ShellMail Website](https://shellmail.ai)
- [API Documentation](https://shellmail.ai/llms.txt)
- [GitHub](https://github.com/aaronbatchelder/shellmail)

## License

MIT
