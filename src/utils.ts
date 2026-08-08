/**
 * utils.ts
 *
 * Shared pure utility functions used across multiple modules.
 * No VS Code dependency — safe to use in vscode-free files and unit tests.
 */

import { ChatMessage } from './client';

/** Returns true for the compact-marker system messages inserted by compactSession(). */
export function isCompactMarker(m: ChatMessage): boolean {
  return m.role === 'system' && m.content.startsWith('__compacted__');
}

/**
 * System prompt used when extracting a structured summary of messages that are about
 * to be trimmed during compaction. Produces typed arrays the model can reconstruct
 * context from, rather than lossy prose — keeps exact file paths, function names, and
 * error messages verbatim.
 */
export const COMPACT_EXTRACTION_PROMPT =
  `You are compacting conversation history that is being trimmed to save context space. Extract the key facts from the messages below into a terse structured block. Preserve exact file paths, function names, and error messages verbatim.

Format:
decisions: <architectural decisions made and why>
constraints: <rules, non-negotiables, requirements>
openFiles: <files actively worked on and their purpose>
openQuestions: <unresolved questions or blockers>
recentErrors: <errors or stack traces mentioned>
nextSteps: <what was about to happen next>

Omit any section that has nothing to report. Output ONLY the structured block, no preamble or explanation.`;

/**
 * Builds a compact extraction input from a list of messages, staying within a
 * token budget. Takes messages from the END (most recent context first) so the
 * model receives the most relevant decisions even when history is very long.
 * Each message is truncated to maxCharsPerMsg before the budget check.
 */
export function buildExtractionInput(
  messages: ChatMessage[],
  budgetTokens = 3000,
  maxCharsPerMsg = 600
): string {
  const lines: string[] = [];
  let usedTokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const label = m.role === 'user' ? 'User' : 'Assistant';
    const text = `${label}: ${m.content.slice(0, maxCharsPerMsg)}`;
    const cost = Math.ceil(text.length / 4);
    if (usedTokens > 0 && usedTokens + cost > budgetTokens) break;
    lines.unshift(text);
    usedTokens += cost;
  }
  return lines.join('\n\n');
}

/** Estimates token count from raw text using the ~4 chars/token heuristic. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Sums estimated token counts across a message array, excluding system messages. */
export function estimateHistoryTokens(history: ChatMessage[]): number {
  return history
    .filter(m => m.role !== 'system')
    .reduce((sum, m) => {
      let t = estimateTokens(m.content);
      if (m.tool_calls) t += m.tool_calls.reduce((s, tc) => s + estimateTokens(tc.function.arguments), 0);
      if (m.images) t += m.images.reduce((s, img) => s + Math.ceil(img.length / 4), 0);
      return sum + t;
    }, 0);
}

/** Returns all messages in a history that are not system messages. */
export function getNonSystemMessages(history: ChatMessage[]): ChatMessage[] {
  return history.filter(m => m.role !== 'system');
}

/**
 * Strips HTML tags, boilerplate elements (style, script, nav, header, footer),
 * and HTML entities from a raw HTML string, returning readable plain text.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parses a raw HTTP error response body, trying JSON first to extract a
 * human-readable error message, falling back to the raw text.
 */
export function parseHttpError(raw: string): string {
  try {
    const j = JSON.parse(raw);
    return j.error?.message || j.error || j.message || raw;
  } catch {
    return raw;
  }
}

/** Maximum character length used when truncating descriptions and log snippets. */
export const TRUNCATE_LENGTH = 200;

/**
 * Returns true when the URL targets a private/internal network address that
 * should never be reachable from user-facing fetch calls (SSRF protection).
 *
 * Covers loopback, link-local (AWS metadata), RFC-1918 private ranges, and
 * the IPv6 equivalents. Also blocks file:// and non-http(s) schemes.
 */
export function isPrivateUrl(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return true; } // unparseable → block
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  // Loopback
  if (h === 'localhost' || h === '0.0.0.0') return true;
  if (/^127\./.test(h)) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;

  // Link-local (AWS/GCP metadata)
  if (/^169\.254\./.test(h)) return true;
  if (/^fe80:/i.test(h)) return true;

  // RFC-1918 private ranges
  if (/^10\./.test(h)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;

  // Unique-local IPv6
  if (/^fc/i.test(h) || /^fd/i.test(h)) return true;

  return false;
}
