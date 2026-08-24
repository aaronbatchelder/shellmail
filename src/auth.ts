/**
 * Auth utilities for ShellMail
 * Token-per-address model: each address has its own bearer token
 */

/** Generate a random token with sm_ prefix */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sm_${hex}`;
}

/** Generate a UUID v4 */
export function generateId(): string {
  return crypto.randomUUID();
}

/** Generate a random local part for auto-generated addresses */
export function generateLocalPart(): string {
  const adjectives = ["swift", "quick", "bright", "calm", "cool", "keen", "bold", "fair"];
  const nouns = ["shell", "wave", "reef", "crab", "tide", "sand", "surf", "coral"];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 9000) + 1000; // 4 digit number
  return `${adj}-${noun}-${num}`;
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
  const match = auth.match(/^Bearer\s+(sm_[a-f0-9]+)$/i);
  return match ? match[1] : null;
}

/** Constant-time string comparison — avoids leaking secret prefixes via timing */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/** Validate local part of email address */
export function validateLocalPart(local: string): string | null {
  if (!local || typeof local !== "string") return "local part is required";
  if (local.length < 2) return "local part must be at least 2 characters";
  if (local.length > 64) return "local part must be at most 64 characters";
  if (!/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i.test(local))
    return "local part must be alphanumeric (dots, hyphens, underscores allowed)";
  if (local.includes(".."))
    return "local part cannot contain consecutive dots";
  // Reserved words
  const reserved = [
    "admin",
    "administrator",
    "postmaster",
    "abuse",
    "hostmaster",
    "webmaster",
    "support",
    "noreply",
    "no-reply",
    "mailer-daemon",
    "root",
    "security",
    "help",
    "info",
    "billing",
    "sales",
    "contact",
    "legal",
    "privacy",
    "dmarc",
    "spf",
    "shellmail",
  ];
  if (reserved.includes(local.toLowerCase()))
    return `"${local}" is reserved`;
  return null;
}

/** Validate email format (basic) */
export function validateEmail(email: string): boolean {
  if (typeof email !== "string" || email.length > 320) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
