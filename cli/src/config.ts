/**
 * Configuration management for ShellMail CLI
 * Supports multiple inbox profiles
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface ProfileConfig {
  token: string;
  address: string;
}

export interface ShellMailConfig {
  /** Currently active profile name */
  activeProfile?: string;
  /** All saved profiles */
  profiles?: Record<string, ProfileConfig>;
  /** API base URL override */
  apiUrl?: string;
  // Legacy fields (for backwards compatibility)
  token?: string;
  address?: string;
}

const CONFIG_DIR = join(homedir(), ".shellmail");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const DEFAULT_PROFILE = "default";

export function loadConfig(): ShellMailConfig {
  if (existsSync(CONFIG_FILE)) {
    try {
      const data = readFileSync(CONFIG_FILE, "utf-8");
      const config = JSON.parse(data) as ShellMailConfig;

      // Migrate legacy config to profile format
      if (config.token && !config.profiles) {
        config.profiles = {
          [DEFAULT_PROFILE]: {
            token: config.token,
            address: config.address || "",
          },
        };
        config.activeProfile = DEFAULT_PROFILE;
        // Keep legacy fields for now but save in new format
        saveConfig(config);
      }

      return config;
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

/**
 * Get the active profile name (from env, flag, or config)
 */
export function getActiveProfile(flagProfile?: string): string {
  // 1. Command line flag takes precedence
  if (flagProfile) return flagProfile;

  // 2. Environment variable
  if (process.env.SHELLMAIL_PROFILE) return process.env.SHELLMAIL_PROFILE;

  // 3. Config file
  const config = loadConfig();
  return config.activeProfile || DEFAULT_PROFILE;
}

/**
 * Get token for the active profile
 */
export function getToken(profileName?: string): string | undefined {
  // Environment variable takes precedence over everything
  if (process.env.SHELLMAIL_TOKEN) {
    return process.env.SHELLMAIL_TOKEN;
  }

  const config = loadConfig();
  const profile = profileName || getActiveProfile();

  // Check profiles first
  if (config.profiles?.[profile]) {
    return config.profiles[profile].token;
  }

  // Fall back to legacy token field
  return config.token;
}

/**
 * Get address for the active profile
 */
export function getAddress(profileName?: string): string | undefined {
  if (process.env.SHELLMAIL_ADDRESS) {
    return process.env.SHELLMAIL_ADDRESS;
  }

  const config = loadConfig();
  const profile = profileName || getActiveProfile();

  if (config.profiles?.[profile]) {
    return config.profiles[profile].address;
  }

  return config.address;
}

/**
 * Save a profile
 */
export function saveProfile(name: string, token: string, address: string): void {
  const config = loadConfig();

  if (!config.profiles) {
    config.profiles = {};
  }

  config.profiles[name] = { token, address };

  // Set as active if it's the first profile or named "default"
  if (!config.activeProfile || name === DEFAULT_PROFILE) {
    config.activeProfile = name;
  }

  saveConfig(config);
}

/**
 * Set the active profile
 */
export function setActiveProfile(name: string): boolean {
  const config = loadConfig();

  if (!config.profiles?.[name]) {
    return false;
  }

  config.activeProfile = name;
  saveConfig(config);
  return true;
}

/**
 * Delete a profile
 */
export function deleteProfile(name: string): boolean {
  const config = loadConfig();

  if (!config.profiles?.[name]) {
    return false;
  }

  delete config.profiles[name];

  // If we deleted the active profile, switch to another
  if (config.activeProfile === name) {
    const remaining = Object.keys(config.profiles);
    config.activeProfile = remaining.length > 0 ? remaining[0] : undefined;
  }

  saveConfig(config);
  return true;
}

/**
 * List all profiles
 */
export function listProfiles(): Array<{ name: string; address: string; active: boolean }> {
  const config = loadConfig();

  if (!config.profiles) {
    // Legacy config
    if (config.token) {
      return [{
        name: DEFAULT_PROFILE,
        address: config.address || "unknown",
        active: true,
      }];
    }
    return [];
  }

  return Object.entries(config.profiles).map(([name, profile]) => ({
    name,
    address: profile.address,
    active: config.activeProfile === name,
  }));
}

/**
 * Rename a profile
 */
export function renameProfile(oldName: string, newName: string): boolean {
  const config = loadConfig();

  if (!config.profiles?.[oldName] || config.profiles[newName]) {
    return false;
  }

  config.profiles[newName] = config.profiles[oldName];
  delete config.profiles[oldName];

  if (config.activeProfile === oldName) {
    config.activeProfile = newName;
  }

  saveConfig(config);
  return true;
}
