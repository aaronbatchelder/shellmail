/**
 * OTP Extraction Module
 * Extracts verification codes and magic links from email content
 */

export interface OtpResult {
  code: string | null;
  link: string | null;
}

/** Common OTP code patterns */
const CODE_PATTERNS = [
  // "Your code is 123456" / "verification code: 123456"
  /(?:code|pin|otp|password|passcode)[\s:]*(\d{4,8})/i,
  // "Enter 123456 to verify"
  /(?:enter|use|type)[\s:]*(\d{4,8})/i,
  // Standalone 6-digit codes (most common)
  /\b(\d{6})\b/,
  // 4-digit codes
  /\b(\d{4})\b/,
  // 8-digit codes
  /\b(\d{8})\b/,
  // Alphanumeric codes like "A1B2C3"
  /(?:code|pin|otp)[\s:]*([A-Z0-9]{6,8})/i,
];

/** Magic link / verification link patterns */
const LINK_PATTERNS = [
  // Common verification URL patterns
  /https?:\/\/[^\s<>"]+(?:verify|confirm|activate|auth|login|magic|token|code)[^\s<>"]*/gi,
  // Links with common query params
  /https?:\/\/[^\s<>"]+[?&](?:token|code|key|confirm|verify)=[^\s<>"]+/gi,
];

/** Keywords that indicate an email contains verification content */
const VERIFICATION_KEYWORDS = [
  'verification',
  'verify',
  'confirm',
  'code',
  'otp',
  'one-time',
  'one time',
  'password',
  'passcode',
  'login',
  'sign in',
  'sign-in',
  'authenticate',
  'magic link',
  '2fa',
  'two-factor',
  'two factor',
  'security code',
];

/** Check if content likely contains verification info */
function isVerificationEmail(subject: string, body: string): boolean {
  const combined = `${subject} ${body}`.toLowerCase();
  return VERIFICATION_KEYWORDS.some(kw => combined.includes(kw));
}

/** Extract OTP code from text */
function extractCode(text: string): string | null {
  // Clean up the text
  const cleaned = text
    .replace(/=\r?\n/g, '') // Remove soft line breaks (quoted-printable)
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, ' ') // Strip HTML tags
    .replace(/\s+/g, ' ');

  for (const pattern of CODE_PATTERNS) {
    const match = cleaned.match(pattern);
    if (match && match[1]) {
      // Validate it's not a year or other common false positive
      const code = match[1];
      const num = parseInt(code, 10);

      // Skip years (1900-2100)
      if (num >= 1900 && num <= 2100 && code.length === 4) continue;

      // Skip common false positives
      if (['0000', '1234', '123456', '12345678'].includes(code)) continue;

      return code;
    }
  }

  return null;
}

/** Extract verification link from text */
function extractLink(text: string): string | null {
  // Clean up the text
  const cleaned = text
    .replace(/=\r?\n/g, '') // Remove soft line breaks
    .replace(/=3D/g, '=')   // Decode quoted-printable equals
    .replace(/&amp;/g, '&');

  for (const pattern of LINK_PATTERNS) {
    const matches = cleaned.match(pattern);
    if (matches && matches.length > 0) {
      // Return the first valid-looking verification link
      for (const match of matches) {
        // Clean up the URL
        let url = match.replace(/[<>"'\s]+$/, '');

        // Skip tracking pixels and common non-verification URLs
        if (url.includes('unsubscribe')) continue;
        if (url.includes('tracking')) continue;
        if (url.includes('.gif')) continue;
        if (url.includes('.png')) continue;
        if (url.includes('.jpg')) continue;

        return url;
      }
    }
  }

  return null;
}

/** Main extraction function */
export function extractOtp(
  subject: string | null,
  bodyText: string | null,
  bodyHtml: string | null
): OtpResult {
  const subj = subject || '';
  const text = bodyText || '';
  const html = bodyHtml || '';

  // Combine all content for analysis
  const combined = `${subj}\n${text}\n${html}`;

  // Quick check if this is likely a verification email
  if (!isVerificationEmail(subj, combined)) {
    return { code: null, link: null };
  }

  // Try to extract code (prefer plain text, fall back to HTML)
  let code = extractCode(text) || extractCode(html) || extractCode(subj);

  // Try to extract link (prefer HTML for better URL parsing)
  let link = extractLink(html) || extractLink(text);

  return { code, link };
}
