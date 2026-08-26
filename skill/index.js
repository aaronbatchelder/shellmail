import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// Skill-only bundle: all functionality lives in the packaged ShellMail skill
// (SKILL.md + scripts/shellmail.sh). There are no runtime tools, providers,
// or channels to register — this entry exists to satisfy the OpenClaw
// package contract and to give hosts an inspectable identity.
export default definePluginEntry({
  id: "shellmail",
  name: "ShellMail",
  description:
    "Full email client for AI agents via the ShellMail API: inbox, OTP extraction, search, send/reply, and confirmation-gated destructive commands. Provided as a skill bundle.",
  register() {},
});
