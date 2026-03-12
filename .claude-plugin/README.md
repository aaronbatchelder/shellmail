# ShellMail Plugin

Email for AI agents via [shellmail.ai](https://shellmail.ai). Create inboxes, receive mail, extract OTPs automatically.

## Installation

```bash
claude plugin install https://github.com/aaronbatchelder/shellmail
```

## Security & Privacy Considerations

⚠️ **Important: This plugin requires and uses sensitive credentials**

### What This Plugin Does
- Creates and manages email inboxes for AI agents
- Reads incoming emails and extracts OTP/verification codes
- Searches, archives, and manages email messages
- Sends emails on your behalf

### Required Credentials
This plugin requires a `SHELLMAIL_TOKEN` which grants **full access** to:
- All emails in your ShellMail inbox
- All OTP/verification codes received
- Ability to send emails from your address
- Ability to configure webhooks

### Token Persistence
When you first set up this skill, the SKILL.md instructions guide the agent to save your `SHELLMAIL_TOKEN` into the agent's configuration using `gateway config.patch`. This means:
- ✅ **Benefit**: The agent will have persistent access to check your email and OTPs without asking for credentials each time
- ⚠️ **Consideration**: The token remains active until you explicitly revoke it or remove it from your config
- 🔐 **Recommendation**: Only use this plugin if you fully trust the shellmail.ai service and understand the privacy implications

### Best Practices
1. **Use a dedicated inbox**: Consider using ShellMail for agent-related activities only, not personal email
2. **Use throwaway/separate accounts**: When possible, use disposable recovery emails during setup
3. **Don't provide recovery emails you don't control**: Only use recovery emails you own
4. **Review the config before applying**: When the agent shows you the `gateway config.patch` command, review it before confirming
5. **Store tokens securely**: If you save your token elsewhere, keep it in a secure password manager
6. **Revoke when done**: Remove the token from your config when you no longer need the skill
7. **Monitor usage**: Periodically check your ShellMail inbox for unexpected activity

### How to Revoke Access
To remove the token from your agent configuration:
```bash
gateway config.patch '{"skills":{"entries":{"shellmail":{"env":{"SHELLMAIL_TOKEN":""}}}}}'
```

Or delete your ShellMail address entirely:
```bash
./skill/scripts/shellmail.sh delete-account
```

## Features

### Email Management
- Check inbox (all emails or unread only)
- Read full email content
- Mark emails as read/unread
- Archive or delete emails
- Search emails by content, sender, or OTP presence

### OTP Extraction
- Automatically extract OTP/verification codes from emails
- Wait for OTPs with configurable timeout
- Filter OTPs by sender domain

### Account Management
- Create new email addresses (custom or auto-generated)
- Recover lost tokens via recovery email
- Address reclaim flow (14-day hold window for deleted addresses)
- Multi-inbox profile support

## Usage

See the [skill documentation](../skill/SKILL.md) for detailed usage instructions and command reference.

## Support

- Website: https://shellmail.ai
- GitHub: https://github.com/aaronbatchelder/shellmail
- Issues: https://github.com/aaronbatchelder/shellmail/issues

## License

MIT
