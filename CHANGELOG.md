# Changelog

Notable changes to ShellMail across its surfaces (API/worker, skill, plugin, CLI, MCP server, SDK).

## 2026-08-25 — Security hardening release

**Worker / API**
- Resend bounce webhook now verifies Svix HMAC-SHA256 signatures (constant-time comparison, 5-minute replay window) and fails closed without `RESEND_WEBHOOK_SECRET` — forged bounce events can no longer suspend addresses
- Recovery-verification OTP hardened: confirm endpoint rate-limited, codes invalidated after 5 wrong guesses, stored as SHA-256 hashes (migration `0012_verification_hardening.sql`)
- Merged upstream security/quality pass (#1): admin header auth with constant-time compare, SSRF guard on webhook URLs, subject header-injection stripping, LIKE-wildcard escaping, send quota consumed only on successful sends, LF-only email parsing fix, thread routing fix
- Shipped authentication tiers (verify recovery email to raise send limit 10/day → 50/day) and anti-spam (content filtering, burst limits, bounce tracking with auto-suspend)
- 118/118 tests passing

**Skill (ClawHub `shellmail` v1.3.1)**
- Resolved all six SkillSpector findings: honest full-capability description, ShellMail-only triggers, least-privilege network declaration, `--confirm` required for `delete`/`delete-address`, prompt-injection defense guidance
- Credential-redirection guard: non-default `SHELLMAIL_API_URL` refused unless https with explicit `SHELLMAIL_ALLOW_CUSTOM_API=1`
- Scan results: SkillSpector 0 issues / SAFE, ClawScan benign

**Plugin (ClawHub `@aaronbatchelder/shellmail` v1.3.2)**
- First plugin release, bundling the hardened skill
- Declares an OpenClaw runtime entrypoint (skill-only bundle, explicit no-op `register()`); zero validation warnings

**CLI (`shellmail` v1.5.0)**
- `delete` prompts for confirmation (`-y` to skip)
- `--version` matches package.json; description covers the full capability set
- New `auth verify-recovery` / `auth status` commands

**MCP server (`shellmail-mcp` v1.3.0)**
- All 9 tools annotated (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`)
- `shellmail_delete` declares permanence and requires `confirm: true`; `shellmail_send` declares real outbound sending

**SDK (`@shellmail/sdk` v1.3.0)**
- JSDoc distinguishes `deleteEmail` (immediate hard delete) from `deleteAccount` (address held 14 days; mail destroyed immediately)

**Site**
- Landing page and `llms.txt` document auth tiers, anti-spam, delete permanence, and confirmation requirements
- Removed deprecated OpenAI `ai-plugin.json` manifest
