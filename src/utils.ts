/**
 * utils.ts
 *
 * Shared pure utility functions used across multiple modules.
 * No VS Code dependency — safe to use in vscode-free files and unit tests.
 */

import { ChatMessage } from './client';

/** Estimates token count from raw text using the ~4 chars/token heuristic. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Sums estimated token counts across a message array, excluding system messages. */
export function estimateHistoryTokens(history: ChatMessage[]): number {
  return history
    .filter(m => m.role !== 'system')
    .reduce((sum, m) => sum + estimateTokens(m.content), 0);
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
