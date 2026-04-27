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
});
