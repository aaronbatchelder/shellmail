import { Env, FilterResult, ContentFilter } from './types';

/**
 * Scans email content for spam patterns and malicious content
 * Returns a FilterResult with pass/fail status and recommended action
 */
export async function scanContent(
  env: Env,
  subject: string,
  bodyText: string,
  bodyHtml: string | undefined,
  to: string[]
): Promise<FilterResult> {
  // Load enabled filters from database
  const filters = await env.DB.prepare(
    `SELECT pattern_type, pattern, severity, description
     FROM content_filters
     WHERE enabled = 1`
  ).all<ContentFilter>();

  let totalScore = 0;
  const matches: string[] = [];

  // Combine text and html for scanning
  const fullBody = bodyText + ' ' + (bodyHtml || '');

  // Check each filter
  for (const filter of filters.results) {
    let matched = false;

    switch (filter.pattern_type) {
      case 'keyword':
      case 'regex':
        try {
          const regex = new RegExp(filter.pattern, 'i');
          if (regex.test(subject) || regex.test(fullBody)) {
            matched = true;
          }
        } catch (e) {
          // Invalid regex, skip
          console.error(`Invalid regex pattern: ${filter.pattern}`, e);
        }
        break;

      case 'pattern':
        if (filter.pattern === 'SUBJECT_ALL_CAPS') {
          // Check if subject is all uppercase (and has at least 10 chars)
          if (subject.length >= 10 && subject === subject.toUpperCase() && /[A-Z]/.test(subject)) {
            matched = true;
          }
        } else if (filter.pattern === 'EXCESSIVE_LINKS') {
          // Checked separately below
        }
        break;
    }

    if (matched) {
      totalScore += filter.severity;
      matches.push(filter.description || filter.pattern);
    }
  }

  // Check for excessive links (more than 5 HTTP/HTTPS URLs)
  const linkCount = (fullBody.match(/https?:\/\/[^\s<>"]+/gi) || []).length;
  if (linkCount > 5) {
    totalScore += 40;
    matches.push(`excessive_links (${linkCount} URLs)`);
  }

  // Check for suspicious URL shorteners in bulk
  const shortenerPatterns = /(bit\.ly|tinyurl\.com|goo\.gl|ow\.ly|t\.co)\/[^\s<>"]+/gi;
  const shortenerCount = (fullBody.match(shortenerPatterns) || []).length;
  if (shortenerCount >= 3) {
    totalScore += 50;
    matches.push(`multiple_url_shorteners (${shortenerCount})`);
  }

  // Check for excessive capitalization (>50% caps)
  const capsRatio = (fullBody.match(/[A-Z]/g) || []).length / fullBody.length;
  if (capsRatio > 0.5 && fullBody.length > 100) {
    totalScore += 30;
    matches.push('excessive_capitalization');
  }

  // Check for suspicious character patterns (mixed scripts, homoglyphs)
  if (/[а-яА-Я]/.test(fullBody) && /[a-zA-Z]/.test(fullBody)) {
    // Mixed Cyrillic and Latin (common in phishing)
    totalScore += 60;
    matches.push('mixed_scripts_cyrillic_latin');
  }

  // Determine action based on total score
  let action: 'allow' | 'flag' | 'reject';
  if (totalScore >= 80) {
    action = 'reject';
  } else if (totalScore >= 50) {
    action = 'flag';
  } else {
    action = 'allow';
  }

  return {
    passed: action === 'allow',
    score: totalScore,
    matches,
    action
  };
}

/**
 * Add a new content filter pattern
 */
export async function addContentFilter(
  env: Env,
  patternType: string,
  pattern: string,
  severity: number,
  description: string
): Promise<void> {
  const id = `cf_custom_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  await env.DB.prepare(
    `INSERT INTO content_filters (id, pattern_type, pattern, severity, description, enabled)
     VALUES (?, ?, ?, ?, ?, 1)`
  ).bind(id, patternType, pattern, severity, description).run();
}

/**
 * Disable a content filter
 */
export async function disableContentFilter(env: Env, filterId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE content_filters SET enabled = 0, updated_at = datetime('now') WHERE id = ?`
  ).bind(filterId).run();
}

/**
 * Enable a content filter
 */
export async function enableContentFilter(env: Env, filterId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE content_filters SET enabled = 1, updated_at = datetime('now') WHERE id = ?`
  ).bind(filterId).run();
}
