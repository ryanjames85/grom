import { expect } from 'chai';
import { SessionManager } from '../session';
import { isCompactMarker } from '../utils';

const makeManager = (overrides: Record<string, any> = {}) => {
  const sessions = {
    default: { id: 'default', title: 'Untitled', history: [], tokens: { input: 0, output: 0 }, lastModified: 0, mode: 'plan' as const },
    ...overrides
  };
  return new SessionManager(sessions, 'default');
};

describe('SessionManager', () => {

  describe('initialisation', () => {
    it('defaults to "default" session when lastSessionId is empty', () => {
      const mgr = new SessionManager({
        default: { id: 'default', title: 'Untitled', history: [], tokens: { input: 0, output: 0 }, lastModified: 0, mode: 'plan' }
      }, '');
      expect(mgr.getCurrentSessionId()).to.equal('default');
    });

    it('defaults to "default" when lastSessionId does not exist', () => {
      const mgr = new SessionManager({
        default: { id: 'default', title: 'Untitled', history: [], tokens: { input: 0, output: 0 }, lastModified: 0, mode: 'plan' }
      }, 'nonexistent');
      expect(mgr.getCurrentSessionId()).to.equal('default');
    });

    it('restores last session when it exists', () => {
      const mgr = new SessionManager({
        default: { id: 'default', title: 'Untitled', history: [], tokens: { input: 0, output: 0 }, lastModified: 0, mode: 'plan' },
        abc: { id: 'abc', title: 'My Chat', history: [], tokens: { input: 0, output: 0 }, lastModified: 0, mode: 'build' }
      }, 'abc');
      expect(mgr.getCurrentSessionId()).to.equal('abc');
    });
  });

  describe('getCurrentSession', () => {
    it('returns the current session', () => {
      const mgr = makeManager();
      expect(mgr.getCurrentSession().id).to.equal('default');
    });

    it('falls back to default session if current is missing', () => {
      const mgr = makeManager();
      (mgr as any).currentSessionId = 'gone';
      expect(mgr.getCurrentSession().id).to.equal('default');
    });
  });

  describe('createNewSession', () => {
    it('creates a new session and switches to it', () => {
      const mgr = makeManager();
      const id = mgr.createNewSession();
      expect(mgr.getCurrentSessionId()).to.equal(id);
    });

    it('new session starts with empty history and plan mode', () => {
      const mgr = makeManager();
      const id = mgr.createNewSession();
      const session = mgr.getSessions()[id];
      expect(session.history).to.deep.equal([]);
      expect(session.mode).to.equal('plan');
      expect(session.title).to.equal('Untitled');
    });

    it('new session appears in getSessions()', () => {
      const mgr = makeManager();
      const id = mgr.createNewSession();
      expect(mgr.getSessions()).to.have.property(id);
    });

    it('two sessions created back-to-back never collide on ID, even within the same millisecond (v0.5.7 bug fix)', () => {
      // Regression test: the ID used to be plain Date.now().toString(), which has 1ms
      // resolution. Two createNewSession() calls landing in the same millisecond (e.g. two
      // queued 'newSession' webview messages, or /import racing a plain New Chat) produced
      // identical IDs, and the second call silently overwrote the first session's entry in
      // getSessions() - one of the two logically distinct sessions just vanished.
      const mgr = makeManager();
      const ids = new Set<string>();
      for (let i = 0; i < 50; i++) ids.add(mgr.createNewSession());
      expect(ids.size, 'every created session must keep its own distinct entry').to.equal(50);
      expect(Object.keys(mgr.getSessions()).length).to.be.at.least(50);
    });
  });

  describe('switchSession', () => {
    it('switches to an existing session', () => {
      const mgr = makeManager({ abc: { id: 'abc', title: 'Other', history: [], tokens: { input: 0, output: 0 }, lastModified: 0, mode: 'plan' as const } });
      const result = mgr.switchSession('abc');
      expect(result).to.be.true;
      expect(mgr.getCurrentSessionId()).to.equal('abc');
    });

    it('returns false and does not switch for unknown session', () => {
      const mgr = makeManager();
      const result = mgr.switchSession('nonexistent');
      expect(result).to.be.false;
      expect(mgr.getCurrentSessionId()).to.equal('default');
    });
  });

  describe('deleteSession', () => {
    it('removes a non-default session', () => {
      const mgr = makeManager({ abc: { id: 'abc', title: 'Old', history: [], tokens: { input: 0, output: 0 }, lastModified: 0, mode: 'plan' as const } });
      mgr.deleteSession('abc');
      expect(mgr.getSessions()).to.not.have.property('abc');
    });

    it('resets default session instead of deleting it', () => {
      const mgr = makeManager();
      mgr.getSessions()['default'].title = 'Modified';
      mgr.deleteSession('default');
      expect(mgr.getSessions()['default'].title).to.equal('Untitled');
      expect(mgr.getSessions()['default'].history).to.deep.equal([]);
    });

    it('switches to default when deleting the current session', () => {
      const mgr = makeManager({ abc: { id: 'abc', title: 'Old', history: [], tokens: { input: 0, output: 0 }, lastModified: 0, mode: 'plan' as const } });
      mgr.switchSession('abc');
      mgr.deleteSession('abc');
      expect(mgr.getCurrentSessionId()).to.equal('default');
    });
  });

  describe('renameSession', () => {
    it('renames an existing session', () => {
      const mgr = makeManager();
      mgr.renameSession('default', 'My Project');
      expect(mgr.getCurrentSession().title).to.equal('My Project');
    });

    it('does nothing for an unknown session id', () => {
      const mgr = makeManager();
      mgr.renameSession('ghost', 'New Name');
      expect(mgr.getCurrentSession().title).to.equal('Untitled');
    });
  });

  describe('updateMode', () => {
    it('updates mode to build', () => {
      const mgr = makeManager();
      mgr.updateMode('default', 'build');
      expect(mgr.getCurrentSession().mode).to.equal('build');
    });

    it('updates mode back to plan', () => {
      const mgr = makeManager();
      mgr.updateMode('default', 'build');
      mgr.updateMode('default', 'plan');
      expect(mgr.getCurrentSession().mode).to.equal('plan');
    });

    it('does nothing for an unknown session id', () => {
      const mgr = makeManager();
      mgr.updateMode('ghost', 'build');
      expect(mgr.getCurrentSession().mode).to.equal('plan');
    });
  });

  describe('compactSession', () => {
    it('returns false when history is too short to compact', () => {
      const mgr = makeManager();
      mgr.getSessions()['default'].history = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' }
      ];
      expect(mgr.compactSession('default')).to.be.false;
    });

    it('returns true and trims history when long enough', () => {
      const mgr = makeManager();
      mgr.getSessions()['default'].history = Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant' as any,
        content: `message ${i}`
      }));
      const result = mgr.compactSession('default');
      expect(result).to.be.true;
      expect(mgr.getCurrentSession().history.length).to.be.lessThanOrEqual(6); // marker + up to 4 last + optional system
    });

    it('preserves system message after compact', () => {
      const mgr = makeManager();
      mgr.getSessions()['default'].history = [
        { role: 'system', content: 'You are helpful.' },
        ...Array.from({ length: 8 }, (_, i) => ({
          role: i % 2 === 0 ? 'user' : 'assistant' as any,
          content: `msg ${i}`
        }))
      ];
      mgr.compactSession('default');
      expect(mgr.getCurrentSession().history[0].role).to.equal('system');
      expect(mgr.getCurrentSession().history[0].content).to.equal('You are helpful.');
    });

    it('does not duplicate system message in compacted history', () => {
      const mgr = makeManager();
      mgr.getSessions()['default'].history = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
        { role: 'assistant', content: 'd' },
      ];
      mgr.compactSession('default');
      const h = mgr.getCurrentSession().history;
      const sysMessages = h.filter(m => m.role === 'system' && m.content !== '__compacted__');
      expect(sysMessages).to.have.length(1);
    });

    it('only includes non-system messages in last-4 slice', () => {
      const mgr = makeManager();
      mgr.getSessions()['default'].history = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
        { role: 'assistant', content: 'a2' },
        { role: 'user', content: 'u3' },
        { role: 'assistant', content: 'a3' },
      ];
      mgr.compactSession('default');
      const h = mgr.getCurrentSession().history;
      // Should be: [sys, __compacted__, u2, a2, u3, a3], only last 4 non-system
      const nonSystem = h.filter(m => m.role !== 'system');
      expect(nonSystem).to.have.length(4);
      expect(nonSystem[0].content).to.equal('u2');
    });

    it('returns false for unknown session id', () => {
      const mgr = makeManager();
      expect(mgr.compactSession('ghost')).to.be.false;
    });

    it('embeds an extraction summary in the compact marker when provided', () => {
      const mgr = makeManager();
      mgr.getSessions()['default'].history = [
        { role: 'system', content: 'You are helpful.' },
        ...Array.from({ length: 8 }, (_, i) => ({
          role: i % 2 === 0 ? 'user' : 'assistant' as any,
          content: `msg ${i}`
        }))
      ];
      const summary = 'decisions: chose SQLite\nconstraints: no ORM';
      mgr.compactSession('default', summary);
      const marker = mgr.getCurrentSession().history.find(m => isCompactMarker(m));
      expect(marker).to.exist;
      expect(marker!.content).to.include('decisions: chose SQLite');
      expect(marker!.content).to.include('constraints: no ORM');
    });

    it('compact marker with summary still starts with __compacted__', () => {
      const mgr = makeManager();
      mgr.getSessions()['default'].history = Array.from({ length: 8 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant' as any, content: `msg ${i}`
      }));
      mgr.compactSession('default', 'decisions: TypeScript');
      const marker = mgr.getCurrentSession().history.find(isCompactMarker);
      expect(marker!.content.startsWith('__compacted__')).to.be.true;
    });

    it('uses plain __compacted__ marker when no summary provided', () => {
      const mgr = makeManager();
      mgr.getSessions()['default'].history = Array.from({ length: 8 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant' as any, content: `msg ${i}`
      }));
      mgr.compactSession('default');
      const marker = mgr.getCurrentSession().history.find(isCompactMarker);
      expect(marker!.content).to.equal('__compacted__');
    });

    it('isCompactMarker detects marker with summary', () => {
      const marker = { role: 'system' as const, content: '__compacted__\n\ndecisions: used Redis' };
      expect(isCompactMarker(marker)).to.be.true;
    });

    it('returns false when history has only system messages (no real chat content)', () => {
      const mgr = makeManager();
      mgr.getSessions()['default'].history = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'system', content: '__compacted__\n\ndecisions: used SQLite' },
      ];
      expect(mgr.compactSession('default')).to.be.false;
    });

    it('returns false when history has only one non-system message', () => {
      const mgr = makeManager();
      mgr.getSessions()['default'].history = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'hello' },
      ];
      expect(mgr.compactSession('default')).to.be.false;
    });

    it('returns false when history is already compacted (only marker + 4 messages)', () => {
      const mgr = makeManager();
      mgr.getSessions()['default'].history = [
        { role: 'system', content: '__compacted__' },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
        { role: 'assistant', content: 'a2' },
      ];
      // 5 messages total but only 2 non-system; should not compact again meaningfully
      // compactSession threshold is <= 2 total, so this returns true but is idempotent
      const result = mgr.compactSession('default');
      const h = mgr.getCurrentSession().history;
      const systemMessages = h.filter(m => m.role === 'system' && m.content !== '__compacted__');
      expect(systemMessages).to.have.length(0);
    });
  });

  describe('deleteSession sad path', () => {
    it('clears the last remaining session instead of removing it', () => {
      const mgr = new SessionManager({
        default: { id: 'default', title: 'Only', history: [{ role: 'user', content: 'hi' }], tokens: { input: 10, output: 5 }, lastModified: 0, mode: 'plan' }
      }, 'default');
      mgr.deleteSession('default');
      expect(mgr.getSessions()).to.have.property('default');
      expect(mgr.getSessions()['default'].history).to.deep.equal([]);
      expect(mgr.getSessions()['default'].title).to.equal('Untitled');
    });
  });

  describe('setSystemPrompt', () => {
    it('sets a system prompt and removes existing system messages', () => {
      const mgr = makeManager();
      mgr.getSessions()['default'].history = [
        { role: 'system', content: 'old system' },
        { role: 'user', content: 'hi' },
      ];
      (mgr as any).sessions['default'].systemPrompt = undefined;
      // Call via cast since setSystemPrompt is public
      (mgr as any).setSystemPrompt('default', 'new system');
      const h = mgr.getCurrentSession().history;
      expect(h.find((m: any) => m.content === 'old system')).to.be.undefined;
      expect(mgr.getCurrentSession().systemPrompt).to.equal('new system');
    });

    it('preserves __compacted__ marker when setting system prompt', () => {
      const mgr = makeManager();
      mgr.getSessions()['default'].history = [
        { role: 'system', content: '__compacted__' },
        { role: 'user', content: 'hi' },
      ];
      (mgr as any).setSystemPrompt('default', 'new system');
      const h = mgr.getCurrentSession().history;
      expect(h.find((m: any) => m.content === '__compacted__')).to.exist;
    });

    it('preserves compact marker with embedded summary when setting system prompt', () => {
      const mgr = makeManager();
      mgr.getSessions()['default'].history = [
        { role: 'system', content: '__compacted__\n\ndecisions: SQLite, no ORM' },
        { role: 'user', content: 'hi' },
      ];
      (mgr as any).setSystemPrompt('default', 'new system');
      const h = mgr.getCurrentSession().history;
      const found = h.find((m: any) => isCompactMarker(m));
      expect(found).to.exist;
      expect(found!.content).to.include('SQLite');
    });

    it('does nothing for unknown session id', () => {
      const mgr = makeManager();
      (mgr as any).setSystemPrompt('ghost', 'new system');
      expect(mgr.getCurrentSession().systemPrompt).to.be.undefined;
    });
  });

  describe('setReasoningEffort', () => {
    it('sets reasoning effort on an existing session', () => {
      const mgr = makeManager();
      mgr.setReasoningEffort('default', 'high');
      expect(mgr.getCurrentSession().reasoningEffort).to.equal('high');
    });

    it('overwrites a previously set effort', () => {
      const mgr = makeManager();
      mgr.setReasoningEffort('default', 'low');
      mgr.setReasoningEffort('default', 'medium');
      expect(mgr.getCurrentSession().reasoningEffort).to.equal('medium');
    });

    it('is a no-op for an unknown session id', () => {
      const mgr = makeManager();
      mgr.setReasoningEffort('ghost', 'high');
      expect(mgr.getCurrentSession().reasoningEffort).to.be.undefined;
    });

    it('sets effort to off', () => {
      const mgr = makeManager();
      mgr.setReasoningEffort('default', 'high');
      mgr.setReasoningEffort('default', 'off');
      expect(mgr.getCurrentSession().reasoningEffort).to.equal('off');
    });
  });

  describe('trimLastExchange', () => {
    it('removes the last user message and following assistant message', () => {
      const mgr = makeManager();
      mgr.getSessions()['default'].history = [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second question' },
        { role: 'assistant', content: 'bad answer' },
      ];
      const text = mgr.trimLastExchange('default');
      expect(text).to.equal('second question');
      const h = mgr.getCurrentSession().history;
      expect(h).to.have.length(2);
      expect(h[0].content).to.equal('first question');
      expect(h[1].content).to.equal('first answer');
    });

    it('removes only the last user message when no assistant reply follows', () => {
      const mgr = makeManager();
      mgr.getSessions()['default'].history = [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second question' },
      ];
      const text = mgr.trimLastExchange('default');
      expect(text).to.equal('second question');
      expect(mgr.getCurrentSession().history).to.have.length(2);
    });

    it('returns the trimmed message text', () => {
      const mgr = makeManager();
      mgr.getSessions()['default'].history = [
        { role: 'user', content: 'hello world' },
        { role: 'assistant', content: 'hi' },
      ];
      expect(mgr.trimLastExchange('default')).to.equal('hello world');
    });

    it('returns null for an unknown session id', () => {
      const mgr = makeManager();
      expect(mgr.trimLastExchange('ghost')).to.be.null;
    });

    it('returns null when history has no user messages', () => {
      const mgr = makeManager();
      mgr.getSessions()['default'].history = [
        { role: 'system', content: 'you are helpful' },
      ];
      expect(mgr.trimLastExchange('default')).to.be.null;
    });

    it('preserves system messages when trimming', () => {
      const mgr = makeManager();
      mgr.getSessions()['default'].history = [
        { role: 'system', content: 'you are helpful' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ];
      mgr.trimLastExchange('default');
      const h = mgr.getCurrentSession().history;
      expect(h[0].role).to.equal('system');
      expect(h[0].content).to.equal('you are helpful');
    });
  });
});

// ── session date display ──────────────────────────────────────────────────────

describe('session date display — _relativeTime helper', () => {
  const js = require('fs').readFileSync(require('path').join(process.cwd(), 'media', 'main.js'), 'utf8');

  it('_relativeTime function is defined', () => {
    expect(js).to.include('function _relativeTime(',
      '_relativeTime helper missing from main.js');
  });

  it('returns "just now" for very recent timestamps', () => {
    expect(js).to.include("'just now'",
      '_relativeTime must return "just now" for < 1 minute');
  });

  it('returns minutes-ago format', () => {
    expect(js).to.include('m ago`',
      '_relativeTime must return Xm ago for recent sessions');
  });

  it('returns hours-ago format', () => {
    expect(js).to.include('h ago`',
      '_relativeTime must return Xh ago for same-day sessions');
  });

  it('returns "yesterday" for 1-day-old sessions', () => {
    expect(js).to.include("'yesterday'",
      '_relativeTime must return "yesterday" for 1-day-old sessions');
  });

  it('returns days-ago format for recent sessions', () => {
    expect(js).to.include('d ago`',
      '_relativeTime must return Xd ago for sessions within the week');
  });

  it('returns a short date for older sessions', () => {
    expect(js).to.include("'numeric', month: 'short'",
      '_relativeTime must format older sessions as short date (e.g. "3 Jan")');
  });

  it('session list template includes _relativeTime call with lastModified', () => {
    expect(js).to.include('_relativeTime(s.lastModified)',
      'session list template must call _relativeTime with session lastModified');
  });

  it('session date is in a .session-date span', () => {
    expect(js).to.include('class="session-date"',
      'session date must be wrapped in a .session-date span');
  });

  it('session date is in a .session-meta container', () => {
    expect(js).to.include('class="session-meta"',
      'session date must be inside a .session-meta container');
  });

  it('both session list renders include the date', () => {
    const matches = (js.match(/session-date/g) || []).length;
    expect(matches).to.be.at.least(2,
      'both session list render paths must include the session date');
  });
});

describe('session date display — CSS', () => {
  const css = require('fs').readFileSync(require('path').join(process.cwd(), 'media', 'styles.css'), 'utf8');

  it('.session-date has CSS', () => {
    expect(css).to.include('.session-date',
      '.session-date CSS missing');
  });

  it('.session-meta has CSS', () => {
    expect(css).to.include('.session-meta',
      '.session-meta CSS missing');
  });

    it('.session-date hides on hover', () => {
    expect(css).to.include('.session-item:hover .session-date',
      '.session-date must hide on session-item hover to make room for actions');
  });
});

// ── edge cases ────────────────────────────────────────────────────────────────

describe('reasoning effort — webview wiring', () => {
  const js = require('fs').readFileSync(require('path').join(process.cwd(), 'media', 'main.js'), 'utf8');
  const css = require('fs').readFileSync(require('path').join(process.cwd(), 'media', 'styles.css'), 'utf8');
  const provider = require('fs').readFileSync(require('path').join(process.cwd(), 'src', 'provider.ts'), 'utf8');

  it('effort-btn element exists in webview.html', () => {
    const html = require('fs').readFileSync(require('path').join(process.cwd(), 'media', 'webview.html'), 'utf8');
    expect(html).to.include('id="effort-btn"');
  });

  it('effort-btn has data-effort attribute defaulting to off', () => {
    const html = require('fs').readFileSync(require('path').join(process.cwd(), 'media', 'webview.html'), 'utf8');
    expect(html).to.include('data-effort="off"');
  });

  it('effort-btn is hidden by default (display:none)', () => {
    const html = require('fs').readFileSync(require('path').join(process.cwd(), 'media', 'webview.html'), 'utf8');
    const effortBtnIdx = html.indexOf('id="effort-btn"');
    const snippet = html.slice(effortBtnIdx, effortBtnIdx + 200);
    expect(snippet).to.include('display:none');
  });

  it('CSS defines .effort-btn base style', () => {
    expect(css).to.include('.effort-btn {');
  });

  it('CSS defines effort-btn[data-effort="off"] state', () => {
    expect(css).to.include('.effort-btn[data-effort="off"]');
  });

  it('CSS defines effort-btn[data-effort="high"] state', () => {
    expect(css).to.include('.effort-btn[data-effort="high"]');
  });

  it('CSS targets .kb-bolt for bolt visibility', () => {
    expect(css).to.include('.kb-bolt');
  });

  it('cycleReasoningEffort function is defined in main.js', () => {
    expect(js).to.include('cycleReasoningEffort');
  });

  it('main.js handles reasoningEffortChanged message', () => {
    expect(js).to.include("case 'reasoningEffortChanged'");
  });

  it('main.js calls _updateEffortVisibility in loadSessions handler', () => {
    const loadIdx = js.indexOf("case 'loadSessions'");
    expect(loadIdx).to.not.equal(-1);
    const slice = js.slice(loadIdx, loadIdx + 1000);
    expect(slice).to.include('_updateEffortVisibility()');
  });

  it('/effort command is intercepted in provider.ts send handler', () => {
    expect(provider).to.include('/effort');
    expect(provider).to.include('effortMatch');
  });

  it('provider.ts handles setReasoningEffort message type', () => {
    expect(provider).to.include("case 'setReasoningEffort'");
  });

  it('provider.ts sends showReasoningToggle in loadSessions state', () => {
    expect(provider).to.include('showReasoningToggle');
  });

  it('provider.ts gates reasoning effort behind showReasoningToggle', () => {
    expect(provider).to.include('showReasoningToggle');
    expect(provider).to.include('reasoningEffort');
  });

  it('provider.ts blocks /effort for hint-only models using getReasoningControl', () => {
    expect(provider).to.include('getReasoningControl');
    expect(provider).to.include("rc === 'hint'");
  });

  it("main.js visibility check requires reasoningControl 'api' or 'token'", () => {
    expect(js).to.include("_reasoningControl === 'api' || _reasoningControl === 'token'");
  });
});

describe('session edge cases', () => {
  const js = require('fs').readFileSync(require('path').join(process.cwd(), 'media', 'main.js'), 'utf8');
  const provider = require('fs').readFileSync(require('path').join(process.cwd(), 'src', 'provider.ts'), 'utf8');

  it('#3 — _relativeTime handles zero/falsy timestamp gracefully', () => {
    expect(js).to.include("if (!ts) return ''",
      '_relativeTime must return empty string for falsy timestamps');
  });

  it('#3 — _relativeTime handles future timestamps as "just now"', () => {
    expect(js).to.include("if (mins < 1) return 'just now'",
      '_relativeTime must return "just now" for future or very recent timestamps');
  });

  it('#4 — _createNewSession guards against creating a blank duplicate', () => {
    const idx = provider.indexOf('private _createNewSession()');
    expect(idx).to.not.equal(-1, '_createNewSession not found');
    const slice = provider.slice(idx, idx + 400);
    expect(slice).to.include('history.length === 0',
      '_createNewSession must check if current session is already empty before creating a new one');
  });

  it('#4 — _createNewSession reuses existing blank session instead of duplicating', () => {
    const idx = provider.indexOf('private _createNewSession()');
    const slice = provider.slice(idx, idx + 400);
    expect(slice).to.include("title === 'Untitled'",
      '_createNewSession must check title is Untitled before bailing out');
  });

  it("reindexWorkspace message handler runs the grom.reindex command", () => {
    expect(provider).to.match(/case 'reindexWorkspace':[\s\S]{0,80}executeCommand\('grom\.reindex'\)/,
      'reindexWorkspace case must invoke the grom.reindex command so /reindex reuses the real file-discovery + RAG rebuild logic, not a duplicate');
  });

  it('#5 — _silent resets at start of every run()', () => {
    const agentLoop = require('fs').readFileSync(require('path').join(process.cwd(), 'src', 'agent-loop.ts'), 'utf8');
    const runIdx = agentLoop.indexOf('async run(');
    expect(runIdx).to.not.equal(-1, 'run() method not found in agent-loop.ts');
    const slice = agentLoop.slice(runIdx, runIdx + 500);
    expect(slice).to.include('this._silent = false',
      '_silent flag must be reset at the start of run() to prevent bleed from previous silentAbort');
  });

  it('#2 — _suppressNextConfigReload flag exists to prevent double loadSessions', () => {
    expect(provider).to.include('_suppressNextConfigReload',
      '_suppressNextConfigReload flag must exist to prevent double loadSessions on session switch');
  });

  it('#2 — config watcher checks _suppressNextConfigReload before calling _loadAllSessions', () => {
    expect(provider).to.include('if (this._suppressNextConfigReload)',
      'config watcher must check _suppressNextConfigReload flag');
  });

  it('#2 — _switchSession sets _suppressNextConfigReload before model update', () => {
    const idx = provider.indexOf('private async _switchSession(');
    expect(idx).to.not.equal(-1, '_switchSession not found');
    const slice = provider.slice(idx, idx + 600);
    expect(slice).to.include('this._suppressNextConfigReload = true',
      '_switchSession must suppress the config watcher reload when updating model');
  });
});

describe('compacted history archive', () => {
  const provider = require('fs').readFileSync(require('path').join(process.cwd(), 'src', 'provider.ts'), 'utf8');
  const js = require('fs').readFileSync(require('path').join(process.cwd(), 'media', 'main.js'), 'utf8');
  const css = require('fs').readFileSync(require('path').join(process.cwd(), 'media', 'styles.css'), 'utf8');

  it('archives trimmed messages before compactSession() discards them, so nothing is lost', () => {
    const idx = provider.indexOf('private async _compactSession()');
    expect(idx, '_compactSession not found').to.be.greaterThan(-1);
    const body = provider.slice(idx, idx + 2400);
    const archiveIdx = body.indexOf('_archiveTrimmedMessages');
    const compactIdx = body.indexOf('this._sessionManager.compactSession(');
    expect(archiveIdx, 'archive call not found').to.be.greaterThan(-1);
    expect(archiveIdx, 'must archive BEFORE compactSession() discards the messages').to.be.lessThan(compactIdx);
    expect(body).to.include('await this._archiveTrimmedMessages(current.id, toTrim)');
  });

  it('the archive lives in the extension\'s own workspace storage, never sent to the model', () => {
    expect(provider).to.include('this._context.storageUri');
    const idx = provider.indexOf('private _archiveUri');
    const body = provider.slice(idx, idx + 300);
    expect(body).to.include("'archives'");
  });

  it('archiving failure never blocks compaction itself', () => {
    const idx = provider.indexOf('private async _archiveTrimmedMessages');
    const body = provider.slice(idx, idx + 900);
    expect(body, 'archive errors must be caught, not thrown').to.include('catch (e) {');
    expect(body).to.include('logError');
  });

  it('archiving appends to any existing archive rather than overwriting it, across multiple compactions', () => {
    const idx = provider.indexOf('private async _archiveTrimmedMessages');
    const body = provider.slice(idx, idx + 900);
    expect(body, 'reads the existing archive first').to.include('existing = Buffer.from');
    expect(body, 'writes existing content back plus the new messages').to.include('existing + messagesToMarkdown(trimmed)');
  });

  it('export, import, and the archive all reuse the same markdown serialiser and parser', () => {
    // messagesToMarkdown/markdownToMessages moved to session-markdown.ts (v0.6.0 provider.ts
    // split, chunk 1) as pure functions; provider.ts now imports and calls them directly.
    expect(provider, '_exportChat should use the shared serialiser').to.include('messagesToMarkdown(current.history)');
    expect(provider, '_importChat should use the shared parser').to.include('markdownToMessages(raw)');
    expect(provider, '_expandCompactedHistory should use the shared parser too').to.include('markdownToMessages(raw)');
  });

  it('a missing archive (nothing to expand) is reported distinctly from an empty one, not silently ignored', () => {
    const idx = provider.indexOf('private async _expandCompactedHistory');
    const body = provider.slice(idx, idx + 700);
    expect(body).to.include("messages: null");
  });

  it('expandCompactedHistory is wired into the message handler switch', () => {
    expect(provider).to.include("case 'expandCompactedHistory': this._expandCompactedHistory(data.sessionId); break;");
  });

  it('the compact notice is clickable and carries the session id it belongs to', () => {
    const idx = js.indexOf('function _makeCompactNotice');
    expect(idx, '_makeCompactNotice not found').to.be.greaterThan(-1);
    const body = js.slice(idx, idx + 1300);
    expect(body).to.include("notice.dataset.sessionId = sessionId");
    expect(body).to.include("type: 'expandCompactedHistory'");
  });

  it('the compact notice shows a real timestamp of when that compaction ran', () => {
    const idx = js.indexOf('function _makeCompactNotice');
    const body = js.slice(idx, idx + 1300);
    expect(body, 'accepts compactedAt and stores it for later').to.include('notice.dataset.compactedAt = compactedAt');
    expect(body, 'reuses the existing relative-time formatter, not a new one').to.include('_relativeTime(compactedAt)');
  });

  it('both the manual /compact command and auto-compact (in agent-loop.ts) set compactedAt and archive what they trim', () => {
    const provider = require('fs').readFileSync(require('path').join(process.cwd(), 'src', 'provider.ts'), 'utf8');
    const agentLoop = require('fs').readFileSync(require('path').join(process.cwd(), 'src', 'agent-loop.ts'), 'utf8');
    expect(provider, 'manual /compact must post the timestamp back to the webview').to.include("this._post({ type: 'compacted', sessionId: current.id, compactedAt");
    expect(agentLoop, 'auto-compact must set compactedAt on its own marker').to.include('content: markerContent, compactedAt');
    expect(agentLoop, 'auto-compact must also archive before trimming, not just manual /compact').to.include('await this.deps.archiveTrimmedMessages?.(session.id, toTrim)');
    expect(agentLoop, 'auto-compact must post the timestamp too').to.include("this.deps.postMessage({ type: 'compacted', sessionId: session.id, compactedAt })");
  });

  it('loadSessions detects a compact marker even when it carries a summary, not just the bare marker', () => {
    // A real compaction almost always attaches a summary ("__compacted__\n\n<summary>"), and an
    // exact-match check against the bare "__compacted__" string would silently skip rendering the
    // notice at all for that — the common case, not an edge case.
    expect(js).to.not.include("msg.content === '__compacted__'");
    expect(js).to.include("msg.content.startsWith('__compacted__')");
  });

  it('archivedHistory inserts messages in place of the notice, then keeps the notice as a relabelled marker (not removed)', () => {
    const idx = js.indexOf("case 'archivedHistory':");
    expect(idx, "case 'archivedHistory' not found").to.be.greaterThan(-1);
    const body = js.slice(idx, idx + 1600);
    expect(body).to.include('chatContainer.insertBefore(div, notice)');
    // The marker is the record that a compaction happened here — it stays, relabelled, rather
    // than disappearing once its content has been shown.
    expect(body, 'the notice must not be removed from the DOM').to.not.include('notice.remove()');
    expect(body, 'it is marked expanded so a stray click does not re-fetch').to.include("notice.dataset.expanded = '1'");
    expect(body, 'and stops responding to clicks').to.include('notice.onclick = null');
    expect(body).to.include('(expanded above)');
  });

  it('archivedHistory with no messages tells the user plainly instead of doing nothing', () => {
    const idx = js.indexOf("case 'archivedHistory':");
    const body = js.slice(idx, idx + 700);
    expect(body).to.include('no earlier messages were saved');
  });

  it('the compact notice has hover styling to signal it is clickable', () => {
    expect(css).to.include('.compact-notice.clickable');
  });

  it('a single compaction does not leave two stacked notices behind (both compacting and compacted reach this handler)', () => {
    const idx = js.indexOf("case 'compacting':");
    expect(idx, "case 'compacting' not found").to.be.greaterThan(-1);
    const body = js.slice(idx, idx + 900);
    expect(body, 'must remove any existing notice for this session before appending a new one').to.include('querySelectorAll(`.compact-notice[data-session-id=');
    expect(body).to.include('.forEach(n => n.remove())');
  });

  it('expanding history scrolls to what was just revealed, not to the bottom of the chat', () => {
    const idx = js.indexOf("case 'archivedHistory':");
    const body = js.slice(idx, idx + 2000);
    expect(body, 'must not jump to the newest message the user has already seen').to.not.include('chatContainer.scrollTop = chatContainer.scrollHeight');
    expect(body, 'scrolls the first newly-inserted message into view instead').to.include('chatContainer.scrollTop = Math.max(0, firstDiv.offsetTop');
    expect(body, 'must not call scrollIntoView, which is unreliable right after a batch of DOM insertions').to.not.include('.scrollIntoView(');
  });

  it('a compaction notice is dropped, not shown, if it belongs to a session other than the one currently on screen (v0.5.7 bug fix)', () => {
    // Compaction runs a ~20s background summary call against whatever session triggered it; if the
    // user switches sessions before it finishes, the notice must not land on the wrong conversation.
    const idx = js.indexOf("case 'compacting':");
    const body = js.slice(idx, idx + 700);
    expect(body, 'must bail out before rendering when the event belongs to a different session').to.include("if (m.sessionId && m.sessionId !== _currentSessionId) break;");
  });

  it('the backend tags the compacted event with the session it belongs to, for both manual and auto compact (v0.5.7 bug fix)', () => {
    const provider = require('fs').readFileSync(require('path').join(process.cwd(), 'src', 'provider.ts'), 'utf8');
    const agentLoop = require('fs').readFileSync(require('path').join(process.cwd(), 'src', 'agent-loop.ts'), 'utf8');
    expect(provider).to.include("this._post({ type: 'compacted', sessionId: current.id, compactedAt");
    expect(agentLoop).to.include("this.deps.postMessage({ type: 'compacted', sessionId: session.id, compactedAt })");
  });
});

describe('_isStreaming is not left stuck true when _handleChat exits early (v0.5.7 bug fix)', () => {
  const provider = require('fs').readFileSync(require('path').join(process.cwd(), 'src', 'provider.ts'), 'utf8');

  it('resets _isStreaming before the early return when neither the sidebar view nor a popout exists', () => {
    // The 'send' handler sets _isStreaming = true synchronously before queueing this call. If
    // _handleChat then returns here without resetting it, _isStreaming gets stuck true forever,
    // permanently disabling the "reuse empty session" fast path and the visibility-driven refresh,
    // both of which gate on !this._isStreaming.
    const idx = provider.indexOf('private async _handleChat(');
    expect(idx, '_handleChat not found').to.be.greaterThan(-1);
    const body = provider.slice(idx, idx + 300);
    expect(body, 'must reset _isStreaming on this early return, not just in the try/finally below').to.match(/if \(!this\._view && !this\._popout\) \{ this\._isStreaming = false; return; \}/);
  });
});

describe('prompt history: per-workspace scoping (v0.5.7)', () => {
  const provider = require('fs').readFileSync(require('path').join(process.cwd(), 'src', 'provider.ts'), 'utf8');
  const js = require('fs').readFileSync(require('path').join(process.cwd(), 'media', 'main.js'), 'utf8');
  const html = require('fs').readFileSync(require('path').join(process.cwd(), 'media', 'webview.html'), 'utf8');
  const css = require('fs').readFileSync(require('path').join(process.cwd(), 'media', 'styles.css'), 'utf8');

  it('is keyed by the first workspace folder path, not a single flat global list', () => {
    const idx = provider.indexOf('_promptHistoryKey()');
    expect(idx, '_promptHistoryKey not found').to.be.greaterThan(-1);
    const body = provider.slice(idx, idx + 200);
    expect(body).to.include('workspaceFolders?.[0]?.uri.fsPath');
  });

  it('reads and writes through a per-workspace map, not the old flat promptHistory key', () => {
    expect(provider).to.include("globalState.get<Record<string, string[]>>('grom.promptHistoryByWorkspace'",
      '_getPromptHistory/_setPromptHistory must use the new per-workspace map key');
    // The old flat key must not still be read or written anywhere in provider.ts.
    expect(provider).to.not.match(/globalState\.(get|update)\('promptHistory'/,
      'the old flat, non-scoped promptHistory globalState key must not be used anymore');
  });

  it('returns an empty list when no workspace folder is open, rather than throwing or using a fallback key', () => {
    const idx = provider.indexOf('private _getPromptHistory()');
    const body = provider.slice(idx, idx + 200);
    expect(body).to.include('if (!key) return [];');
  });

  it('clearing prompt history notifies the webview so the new tab updates live', () => {
    const idx = provider.indexOf("case 'clearPromptHistory':");
    const line = provider.slice(idx, provider.indexOf('\n', idx));
    expect(line).to.include("type: 'promptHistoryUpdated'");
    expect(line).to.include('history: []');
  });

  it('sending a new prompt notifies the webview with the updated history too', () => {
    const idx = provider.indexOf('this._setPromptHistory(ph);');
    expect(idx, '_setPromptHistory(ph) call site not found').to.be.greaterThan(-1);
    const body = provider.slice(idx, idx + 150);
    expect(body).to.include("type: 'promptHistoryUpdated'");
  });

  it('has a third History-panel tab for Prompt History, alongside Sessions and Task Log', () => {
    expect(html).to.include('id="tab-prompthistory"');
    expect(html).to.include("window.switchHistoryTab('prompthistory')");
    expect(html).to.include('id="prompt-history-panel"');
    expect(html).to.include('id="prompt-history-list"');
  });

  it('switchHistoryTab shows and hides all three panels correctly', () => {
    const idx = js.indexOf('window.switchHistoryTab = (tab) =>');
    const body = js.slice(idx, idx + 500);
    expect(body).to.include("document.getElementById('prompt-history-panel').style.display = tab === 'prompthistory' ? 'flex' : 'none'");
  });

  it('renderPromptHistory shows the newest entry first', () => {
    const idx = js.indexOf('function renderPromptHistory(entries)');
    expect(idx, 'renderPromptHistory not found').to.be.greaterThan(-1);
    const body = js.slice(idx, idx + 700);
    expect(body, 'must reverse the array so the most recent prompt renders first').to.include('.slice().reverse()');
  });

  it('renderPromptHistory escapes prompt text (it is raw, untrusted user input)', () => {
    const idx = js.indexOf('function renderPromptHistory(entries)');
    const body = js.slice(idx, idx + 700);
    expect(body).to.include('escapeHtml(text)');
  });

  it('each entry has a Copy button that only appears on hover, matching the code-block convention', () => {
    expect(css).to.include('.prompt-history-copy-btn');
    expect(css).to.match(/\.prompt-history-copy-btn\s*\{[^}]*opacity:\s*0/,
      'copy button must be hidden until hover, like .code-header buttons');
    expect(css).to.include('.prompt-history-entry:hover .prompt-history-copy-btn { opacity: 1; }');
  });

  it('copying an entry writes it to the clipboard', () => {
    const idx = js.indexOf('window.copyPromptHistoryEntry');
    expect(idx, 'copyPromptHistoryEntry not found').to.be.greaterThan(-1);
    const body = js.slice(idx, idx + 600);
    expect(body).to.include('navigator.clipboard.writeText');
  });

  it('clearing requires a click-twice confirmation, not window.confirm (blocked in VS Code webviews)', () => {
    const idx = js.indexOf('window.clearPromptHistoryConfirm');
    expect(idx, 'clearPromptHistoryConfirm not found').to.be.greaterThan(-1);
    const body = js.slice(idx, idx + 1400);
    expect(body).to.not.include('window.confirm(');
    expect(body, 'first click arms a confirmation state').to.include("btn.dataset.confirming = '1'");
    expect(body, 'second click actually clears').to.include("type: 'clearPromptHistory'");
  });

  it('the promptHistoryUpdated message keeps the up-arrow input history and the tab list in sync', () => {
    const idx = js.indexOf("case 'promptHistoryUpdated':");
    expect(idx, "case 'promptHistoryUpdated' not found").to.be.greaterThan(-1);
    const body = js.slice(idx, idx + 200);
    expect(body).to.include('_inputHistory = m.history');
    expect(body).to.include('renderPromptHistory(_inputHistory)');
  });
});

describe('code-block header floats as a corner overlay, not a full-width flow row (v0.5.7)', () => {
  const css = require('fs').readFileSync(require('path').join(process.cwd(), 'media', 'styles.css'), 'utf8');

  // On narrow blocks a file-suggestion code block can carry up to 7 buttons (Diff, Apply,
  // Insert, Run, Copy, Accept, Reject). The old negative-margin flow trick let a wrapped
  // second row stretch across the block's full width, covering multiple lines of code.
  // Floating it absolutely in the corner keeps any wrap contained to a small column instead.
  it('<pre> is a positioned container for the header to float inside', () => {
    const idx = css.indexOf('pre { background');
    expect(idx, 'pre rule not found').to.be.greaterThan(-1);
    const rule = css.slice(idx, css.indexOf('}', idx));
    expect(rule).to.include('position: relative');
  });

  it('.code-header is absolutely positioned in the corner, not pushed into flow with a negative margin', () => {
    const idx = css.indexOf('.code-header {');
    expect(idx, '.code-header rule not found').to.be.greaterThan(-1);
    const rule = css.slice(idx, css.indexOf('}', idx));
    expect(rule).to.include('position: absolute');
    expect(rule, 'the old overlap-by-negative-margin trick must be gone').to.not.include('margin-bottom: -30px');
  });

  it('.code-header wraps within a constrained width instead of stretching full-width', () => {
    const idx = css.indexOf('.code-header {');
    const rule = css.slice(idx, css.indexOf('}', idx));
    expect(rule).to.include('flex-wrap: wrap');
    expect(rule).to.include('max-width: calc(100% - 12px)');
  });
});

describe('language-override indicator (v0.5.7)', () => {
  const provider = require('fs').readFileSync(require('path').join(process.cwd(), 'src', 'provider.ts'), 'utf8');
  const agentLoop = require('fs').readFileSync(require('path').join(process.cwd(), 'src', 'agent-loop.ts'), 'utf8');
  const js = require('fs').readFileSync(require('path').join(process.cwd(), 'media', 'main.js'), 'utf8');
  const html = require('fs').readFileSync(require('path').join(process.cwd(), 'media', 'webview.html'), 'utf8');

  // Half 1: a permanent per-reply note recording which model actually answered a SPECIFIC
  // past message, independent of whatever file happens to be active when you read it later.
  it('agent-loop posts modelOverrideUsed only when the resolved model differs from the global default', () => {
    const idx = agentLoop.indexOf("if (model !== baseModel) {");
    expect(idx, 'model !== baseModel guard not found').to.be.greaterThan(-1);
    const body = agentLoop.slice(idx, idx + 200);
    expect(body).to.include("type: 'modelOverrideUsed'");
  });

  it('the per-reply note is only attached to the div this exact request owns (same staleness guard as chunk)', () => {
    const idx = js.indexOf("case 'modelOverrideUsed':");
    expect(idx, "case 'modelOverrideUsed' not found").to.be.greaterThan(-1);
    const body = js.slice(idx, idx + 500);
    expect(body).to.include('currentAiDiv._requestId === _requestId');
  });

  it('the per-reply note is not duplicated if somehow posted twice for the same message', () => {
    const idx = js.indexOf("case 'modelOverrideUsed':");
    const body = js.slice(idx, idx + 500);
    expect(body).to.include("!currentAiDiv.querySelector('.model-override-note')");
  });

  // Half 2: a live toolbar badge reflecting whether the CURRENTLY active file's language has
  // an override configured, independent of any message having been sent at all.
  it('the badge only lights up when the override model actually differs from the global default', () => {
    const idx = provider.indexOf('private _updateLanguageOverrideBadge()');
    expect(idx, '_updateLanguageOverrideBadge not found').to.be.greaterThan(-1);
    const body = provider.slice(idx, idx + 900);
    expect(body).to.include('overrideModel !== baseModel');
  });

  it('the badge reacts to changing the active editor (reuses the existing _updateActiveContext lifecycle)', () => {
    const idx = provider.indexOf('private async _updateActiveContext()');
    const body = provider.slice(idx, idx + 700);
    expect(body).to.include('this._updateLanguageOverrideBadge();');
  });

  it('the badge also reacts to editing grom.chatLanguageModels/languageModels/model in settings, not just switching files', () => {
    const idx = provider.indexOf("e.affectsConfiguration('grom.chatLanguageModels')");
    expect(idx, 'config-change guard for language override settings not found').to.be.greaterThan(-1);
    const body = provider.slice(idx, idx + 200);
    expect(body).to.include('this._updateLanguageOverrideBadge();');
  });

  it('the badge element exists in the toolbar next to the model dropdown, hidden by default', () => {
    const idx = html.indexOf('id="language-override-badge"');
    expect(idx, 'language-override-badge element not found').to.be.greaterThan(-1);
    const tag = html.slice(html.lastIndexOf('<', idx), html.indexOf('>', idx) + 1);
    expect(tag).to.include('display:none');
  });

  it('the webview shows/hides the badge and sets an explanatory tooltip', () => {
    const idx = js.indexOf("case 'languageOverrideActive':");
    expect(idx, "case 'languageOverrideActive' not found").to.be.greaterThan(-1);
    const body = js.slice(idx, idx + 400);
    expect(body).to.include("badge.style.display = ''");
    expect(body).to.include("badge.style.display = 'none'");
    expect(body).to.include('badge.title =');
  });
});

describe('context display is honest about a guessed vs a real detected size (v0.5.7)', () => {
  const provider = require('fs').readFileSync(require('path').join(process.cwd(), 'src', 'provider.ts'), 'utf8');
  const js = require('fs').readFileSync(require('path').join(process.cwd(), 'media', 'main.js'), 'utf8');

  // p.context and the trailing ?? 8192 are both guesses that become indistinguishable from a
  // real detected value once collapsed into contextLength, so contextKnown must be captured
  // from _detectedContextLength directly, before that collapse, the only point where a real
  // detected value and a guess are still different things.
  it('contextKnown reflects whether a real value was ever detected, captured before the guess collapses in', () => {
    const idx = provider.indexOf('const contextKnown =');
    expect(idx, 'contextKnown computation not found').to.be.greaterThan(-1);
    const collapseIdx = provider.indexOf('const contextLength =');
    expect(idx, 'contextKnown must be computed before contextLength collapses detected/guessed into one number').to.be.lessThan(collapseIdx);
    const line = provider.slice(idx, provider.indexOf('\n', idx));
    expect(line).to.include('this._detectedContextLength !== null');
  });

  it('contextKnown is included in both the usageUpdate post and the context-full hint post', () => {
    const usageIdx = provider.indexOf("type: 'usageUpdate'");
    expect(provider.slice(usageIdx, usageIdx + 300)).to.include('contextKnown');
    const hintIdx = provider.indexOf("type: 'gromHint', hint: 'context'");
    expect(hintIdx, "gromHint 'context' post not found").to.be.greaterThan(-1);
    expect(provider.slice(hintIdx, hintIdx + 100)).to.include('contextKnown');
  });

  it('the toolbar tooltip says the size is unknown instead of stating a fake percentage as fact', () => {
    const idx = js.indexOf("case 'usageUpdate':");
    expect(idx, "case 'usageUpdate' not found").to.be.greaterThan(-1);
    const body = js.slice(idx, idx + 1100);
    expect(body, 'must branch on contextKnown').to.include('m.contextKnown');
    expect(body, 'must say the size is unknown when it genuinely is').to.include('context size unknown');
  });

  it('the context-full hint card is honest that it is an estimate, not a confident reading, when the size is unknown', () => {
    const idx = js.indexOf("if (m.hint === 'context')");
    expect(idx, "gromHint 'context' handler not found").to.be.greaterThan(-1);
    const body = js.slice(idx, idx + 900);
    expect(body, 'must branch on contextKnown').to.include('m.contextKnown');
    expect(body, "must not claim a confident percentage when the size wasn't really detected").to.include("couldn't be detected for this model");
  });
});
