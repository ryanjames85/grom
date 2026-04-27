/**
 * session.ts
 *
 * Chat session data model and manager.
 * A session holds the full message history, token counts, mode (plan/build),
 * an optional per-session system prompt, and the agent task log.
 *
 * SessionManager is a pure in-memory store — it has no side effects.
 * Persistence (workspaceState) is handled by provider.ts which calls _saveState()
 * after any mutating operation.
 *
 * NOTE: This file is intentionally vscode-free and fully covered by unit tests in
 * src/test/session.test.ts.
 */

import { ChatMessage } from './client';
import { estimateHistoryTokens, getNonSystemMessages } from './utils';

export interface TaskLogEntry {
  ts: number;
  tool: string;
  argsSummary: string; // short human-readable args
  snippet: string;     // first ~200 chars of result
}

export interface ChatSession {
  id: string;
  title: string;
  history: ChatMessage[];
  tokens: { input: number, output: number };
  lastModified: number;
  mode: 'plan' | 'build';
  systemPrompt?: string;
  taskLog?: TaskLogEntry[];
}

export class SessionManager {
  private sessions: Record<string, ChatSession>;
  private currentSessionId: string;

  /**
   * Initialises the manager with persisted session data loaded from workspaceState.
   * Falls back to 'default' if the last active session no longer exists.
   */
  constructor(initialSessions: Record<string, ChatSession>, lastSessionId: string) {
    this.sessions = initialSessions;
    this.currentSessionId = lastSessionId || 'default';
    if (!this.sessions[this.currentSessionId]) {
        this.currentSessionId = 'default';
    }
  }

  /** Returns the full sessions map — used by provider.ts to persist and render the session list. */
  getSessions() {
    return this.sessions;
  }

  /** Returns the ID of the currently active session. */
  getCurrentSessionId() {
    return this.currentSessionId;
  }

  /** Returns the currently active session, falling back to 'default' if it can't be found. */
  getCurrentSession() {
    return this.sessions[this.currentSessionId] || this.sessions['default'];
  }

  /** Creates a new empty session, switches to it, and returns its ID. */
  createNewSession() {
    const id = Date.now().toString();
    this.sessions[id] = { id, title: 'Untitled', history: [], tokens: { input: 0, output: 0 }, lastModified: Date.now(), mode: 'plan' };
    this.currentSessionId = id;
    return id;
  }

  /** Switches the active session to the given ID. Returns false if the ID doesn't exist. */
  switchSession(id: string) {
    if (this.sessions[id]) {
      this.currentSessionId = id;
      return true;
    }
    return false;
  }

  /**
   * Deletes a session by ID. If it's the last session, clears it rather than removing it
   * so there is always at least one session in the list. Switches to the most recently
   * modified remaining session if the deleted session was active.
   */
  deleteSession(id: string) {
    const remaining = Object.keys(this.sessions).filter(k => k !== id);
    if (remaining.length === 0) {
      // Last session — clear it rather than leaving nothing
      this.sessions[id] = { id, title: 'Untitled', history: [], tokens: { input: 0, output: 0 }, lastModified: Date.now(), mode: 'plan' };
      return;
    }
    delete this.sessions[id];
    if (this.currentSessionId === id) {
      this.currentSessionId = Object.values(this.sessions)
        .sort((a, b) => b.lastModified - a.lastModified)[0].id;
    }
  }

  /**
   * Trims a long session history down to the system message + last 4 messages,
   * inserting a '__compacted__' marker so the UI can show where the cut was made.
   * Returns false if the session is too short to need compaction (≤3 messages).
   */
  compactSession(sessionId: string): boolean {
    const s = this.sessions[sessionId];
    if (!s || s.history.length <= 2) return false;

    const systemMessage = s.history.find(m => m.role === 'system' && m.content !== '__compacted__');
    const lastMessages = getNonSystemMessages(s.history).slice(-4);
    const marker: ChatMessage = { role: 'system', content: '__compacted__' };
    s.history = systemMessage ? [systemMessage, marker, ...lastMessages] : [marker, ...lastMessages];
    s.tokens.input = estimateHistoryTokens(s.history);
    s.tokens.output = 0;
    return true;
  }

  /** Renames a session. Does nothing if the session ID doesn't exist. */
  renameSession(sessionId: string, title: string) {
    if (this.sessions[sessionId]) {
      this.sessions[sessionId].title = title;
    }
  }

  /** Updates the PLAN/BUILD mode for a session, which affects system prompt tone. */
  updateMode(sessionId: string, mode: 'plan' | 'build') {
    if (this.sessions[sessionId]) {
      this.sessions[sessionId].mode = mode;
    }
  }

  /**
   * Sets a custom system prompt for a session, replacing any previously injected system messages.
   * The '__compacted__' marker is preserved so compaction history isn't lost.
   */
  setSystemPrompt(sessionId: string, prompt: string) {
    if (this.sessions[sessionId]) {
      this.sessions[sessionId].systemPrompt = prompt;
      this.sessions[sessionId].history = this.sessions[sessionId].history.filter(m => m.role !== 'system' || m.content === '__compacted__');
    }
  }

}
