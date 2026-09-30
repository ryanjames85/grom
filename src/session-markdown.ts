/**
 * session-markdown.ts
 *
 * Pure conversion between a session's ChatMessage[] history and the Markdown format used for
 * exporting a chat to a .md file and importing it back. No vscode dependency, no other state -
 * safe to unit test directly. Extracted out of provider.ts as the first step of the
 * provider.ts -> provider.ts/session-controller.ts/chat-controller.ts split.
 */

import { ChatMessage } from './client';
import { isCompactMarker } from './utils';

/** Renders a session's history as Markdown: one "### User"/"### Assistant" section per message,
 *  system messages omitted, a compact marker rendered as a horizontal rule + note. */
export function messagesToMarkdown(messages: ChatMessage[]): string {
  let markdown = '';
  messages.forEach(msg => {
    if (isCompactMarker(msg)) markdown += `---\n*Earlier messages were compacted.*\n\n`;
    else if (msg.role !== 'system') markdown += `### ${msg.role === 'user' ? 'User' : 'Assistant'}\n${msg.content}\n\n`;
  });
  return markdown;
}

/** Parses a Markdown chat export back into a title + ChatMessage[] history. The inverse of
 *  messagesToMarkdown, tolerant of the "# Chat Session: <title>" header and the compact-marker
 *  horizontal rule; lines starting with "> " (the import instructions blockquote) are ignored. */
export function markdownToMessages(raw: string): { title: string; history: ChatMessage[] } {
  const lines = raw.split('\n');
  const history: ChatMessage[] = [];
  let title = 'Imported Chat';
  let currentRole: 'user' | 'assistant' | null = null;
  let currentContent: string[] = [];

  const flush = () => {
    if (currentRole && currentContent.length > 0) {
      history.push({ role: currentRole, content: currentContent.join('\n').trim() });
      currentRole = null; currentContent = [];
    }
  };

  for (const line of lines) {
    if (line.startsWith('# ')) { title = line.slice(2).replace('Chat Session: ', '').trim(); }
    else if (line === '---') { flush(); history.push({ role: 'system', content: '__compacted__' }); }
    else if (line === '### User') { flush(); currentRole = 'user'; }
    else if (line === '### Assistant') { flush(); currentRole = 'assistant'; }
    else if (currentRole && !line.startsWith('> ')) { currentContent.push(line); }
  }
  flush();
  return { title, history };
}
