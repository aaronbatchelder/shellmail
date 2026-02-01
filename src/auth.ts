/**
 * Auth utilities for ClawMail
 * Token-per-address model: each address has its own bearer token
 */

/** Generate a random token with cm_ prefix */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `cm_${hex}`;
}

/** Generate a UUID v4 */
export function generateId(): string {
  return crypto.randomUUID();
}

/** SHA-256 hash a string (for token and recovery email storage) */
export async function hash(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input.toLowerCase().trim());
  const buffer = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Extract bearer token from Authorization header */
export function extractToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(cm_[a-f0-9]+)$/i);
  return match ? match[1] : null;
}

/** Validate local part of email address */
export function validateLocalPart(local: string): string | null {
  if (!local || typeof local !== "string") return "local part is required";
  if (local.length < 2) return "local part must be at least 2 characters";
  if (local.length > 64) return "local part must be at most 64 characters";
  if (!/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i.test(local))
    return "local part must be alphanumeric (dots, hyphens, underscores allowed)";
  // Reserved words
  const reserved = [
    "admin",
    "postmaster",
    "abuse",
    "hostmaster",
    "webmaster",
    "support",
    "noreply",
    "no-reply",
    "mailer-daemon",
    "root",
  ];
  if (reserved.includes(local.toLowerCase()))
    return `"${local}" is reserved`;
  return null;
}

/** Validate email format (basic) */
export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
