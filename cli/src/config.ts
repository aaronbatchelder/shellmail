/**
 * Configuration management for ShellMail CLI
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface ShellMailConfig {
  token?: string;
  address?: string;
  apiUrl?: string;
}

const CONFIG_DIR = join(homedir(), ".shellmail");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function loadConfig(): ShellMailConfig {
  // Environment variables take precedence
  if (process.env.SHELLMAIL_TOKEN) {
    return {
      token: process.env.SHELLMAIL_TOKEN,
      address: process.env.SHELLMAIL_ADDRESS,
      apiUrl: process.env.SHELLMAIL_API_URL,
    };
  }

  // Try to load from config file
  if (existsSync(CONFIG_FILE)) {
    try {
      const data = readFileSync(CONFIG_FILE, "utf-8");
      return JSON.parse(data);
    } catch {
      return {};
    }
  }

  return {};
}

export function saveConfig(config: ShellMailConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }

  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {
    mode: 0o600, // Only owner can read/write
  });
}

export function clearConfig(): void {
  if (existsSync(CONFIG_FILE)) {
    writeFileSync(CONFIG_FILE, "{}", { mode: 0o600 });
  }
}

export function getToken(): string | undefined {
  return process.env.SHELLMAIL_TOKEN || loadConfig().token;
}
