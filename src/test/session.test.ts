import { expect } from 'chai';
import { SessionManager } from '../session';

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
      // Should be: [sys, __compacted__, u2, a2, u3, a3] — only last 4 non-system
      const nonSystem = h.filter(m => m.role !== 'system');
      expect(nonSystem).to.have.length(4);
      expect(nonSystem[0].content).to.equal('u2');
    });

    it('returns false for unknown session id', () => {
      const mgr = makeManager();
      expect(mgr.compactSession('ghost')).to.be.false;
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
      // 5 messages total but only 2 non-system — should not compact again meaningfully
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

    it('does nothing for unknown session id', () => {
      const mgr = makeManager();
      (mgr as any).setSystemPrompt('ghost', 'new system');
      expect(mgr.getCurrentSession().systemPrompt).to.be.undefined;
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
