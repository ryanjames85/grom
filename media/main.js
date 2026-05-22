/**
 * main.js
 *
 * Webview front-end for the Grom chat panel. Runs inside VS Code's sandboxed webview
 * context — no Node.js, no bundler, plain browser JavaScript.
 *
 * Responsibilities:
 *   - Renders chat messages, session list, task log, and approval cards
 *   - Streams AI output chunk-by-chunk and renders Markdown via marked.js
 *   - Manages the provider/model dropdowns (custom grom-select components)
 *   - Handles @ mention file picker, slash command menu, and prompt presets
 *   - Posts user actions (send, abort, session switch, provider change, etc.) to the extension host
 *   - Receives messages from the extension host and updates the UI accordingly
 *
 * NOTE: This file is hand-written with no build step. Keep it dependency-free —
 * only marked.js and highlight.js (copied to media/ at build time) are loaded externally.
 */

const vscode = acquireVsCodeApi();
const chatContainer = document.getElementById('chat-container'), prompt = document.getElementById('prompt');
const sendBtn = document.getElementById('sendBtn'), stopBtn = document.getElementById('stopBtn');
const slashMenu = document.getElementById('slash-menu'), plusMenu = document.getElementById('plus-menu');
const modeToggle = document.getElementById('mode-toggle');
let currentAiDiv = null, currentAiText = "", pendingImages = [], currentMode = 'plan', uploadedContext = [], robotAnimations = true, _lastAutoFiles = [], _currentSessionId = null, _currentCaps = null, _memoryOriginal = '', _memorySaveTimer = null;
let _requestId = 0; // incremented on each send; used to discard stale Ready/chunk messages
let _cancelActiveRename = null; // call this before any session list re-render
let _elapsedTimer = null, _elapsedStart = 0;
let _voiceState = 'idle'; // idle | recording | transcribing — visual state only, audio runs in extension host
let _voiceInputEnabled = true;
function _startElapsedTimer(dotsEl) {
  _elapsedStart = Date.now();
  _elapsedTimer = setInterval(() => {
    const span = dotsEl.querySelector('.elapsed-time');
    if (!span) { clearInterval(_elapsedTimer); _elapsedTimer = null; return; }
    const secs = Math.floor((Date.now() - _elapsedStart) / 1000);
    span.textContent = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : secs + 's';
    if (secs >= 8) span.classList.add('visible');
  }, 1000);
}
function _stopElapsedTimer() { if (_elapsedTimer) { clearInterval(_elapsedTimer); _elapsedTimer = null; } }
let _userScrolledUp = false;
const scrollBtn = document.getElementById('scroll-to-bottom');

function _escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function _initGromSelect(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const _btnTitle = el.dataset.tooltip || '';
  el.innerHTML = `<button class="grom-select-btn" type="button"${_btnTitle ? ` title="${_btnTitle}"` : ''}><span class="grom-select-label">—</span><svg class="grom-select-chevron" width="8" height="5" viewBox="0 0 8 5" fill="currentColor"><path d="M0 0l4 5 4-5z"/></svg></button><div class="grom-select-menu"></div>`;
  const btn = el.querySelector('.grom-select-btn'), lbl = el.querySelector('.grom-select-label'), menu = el.querySelector('.grom-select-menu');
  let _val = '', _opts = [], _change = null;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const was = el.classList.contains('open');
    document.querySelectorAll('.grom-select.open').forEach(s => s.classList.remove('open'));
    if (!was) el.classList.add('open');
  });
  document.addEventListener('click', () => el.classList.remove('open'));
  el.setOptions = opts => {
    _opts = opts;
    menu.innerHTML = opts.map(o => `<div class="grom-select-option${o.value === _val ? ' selected' : ''}" data-value="${_escHtml(o.value)}" title="${_escHtml(o.tooltip || o.label)}"><span class="grom-select-opt-label">${_escHtml(o.label)}</span></div>`).join('');
    menu.querySelectorAll('.grom-select-option').forEach(opt => opt.addEventListener('click', e => {
      e.stopPropagation();
      const v = opt.dataset.value;
      el.setValue(v);
      el.classList.remove('open');
      if (_change) _change({ target: { value: v } });
    }));
  };
  el.setValue = v => {
    _val = v;
    const o = _opts.find(o => o.value === v);
    lbl.textContent = o ? o.label : (v || '—');
    menu.querySelectorAll('.grom-select-option').forEach(o2 => o2.classList.toggle('selected', o2.dataset.value === v));
  };
  Object.defineProperty(el, 'value', { get: () => _val, set: v => el.setValue(v), configurable: true });
  Object.defineProperty(el, 'onchange', { set: fn => { _change = fn; }, configurable: true });
}
_initGromSelect('provider-select');
_initGromSelect('model-select');
chatContainer.addEventListener('scroll', () => {
  const atBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 60;
  _userScrolledUp = !atBottom;
  if (scrollBtn) scrollBtn.style.display = _userScrolledUp ? 'flex' : 'none';
});
window.scrollToBottom = () => { _userScrolledUp = false; if (scrollBtn) scrollBtn.style.display = 'none'; chatContainer.scrollTop = chatContainer.scrollHeight; };

marked.setOptions({ highlight: (code, lang) => hljs.highlightAuto(code).value, langPrefix: 'hljs language-' });

const BOT_SVG = `<svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path class="antenna" d="M12 8V4H8"></path><rect x="4" y="8" width="16" height="12" rx="2"></rect><path d="M2 14h2"></path><path d="M20 14h2"></path><g class="eye-group"><path class="eye" d="M15 13v2"></path><path class="eye" d="M9 13v2"></path><path class="eye-lid" d="M14 14.5c.5.5 1.5.5 2 0"></path><path class="eye-lid" d="M8 14.5c.5.5 1.5.5 2 0"></path></g></svg>`;

let _gromLogoIdle = false;
let _gromLogoState = 'default';
function updateGromLogo() {
    if (!window.GROM_LOGOS) return;
    const b = document.body;
    let state;
    if (b.classList.contains('grom-disconnected')) state = 'disconnected';
    else if (b.classList.contains('grom-error')) state = 'error';
    else if (b.classList.contains('grom-thinking') || b.classList.contains('mode-build')) state = 'building';
    else state = 'default';
    const mini = document.getElementById('mini-grom');
    if (mini) {
        mini.src = state === 'default' ? GROM_LOGOS.default
                 : state === 'building' ? GROM_LOGOS.building || GROM_LOGOS.default
                 : GROM_LOGOS[state] || GROM_LOGOS.default;
    }
    const logo = document.getElementById('main-logo');
    if (!logo) return;
    if (state === _gromLogoState) return;
    _gromLogoState = state;
    if (state === 'default') {
        logo.innerHTML = window.GROM_IDLE_SVG || '';
    } else if (state === 'building') {
        logo.innerHTML = window.GROM_BUILD_SVG || '';
    } else {
        logo.innerHTML = `<img id="grom-logo-img" src="${GROM_LOGOS[state]}" alt="Grom" width="70" height="70">`;
    }
}

function updateCapIcons() {
    const toolIcon = document.querySelector('.cap-tools');
    if (toolIcon) {
        const hasMcp = (document.getElementById('mcp-tool-count')?.textContent || '').includes('tools');
        const isActive = (currentMode === 'build') || hasMcp;
        toolIcon.classList.toggle('inactive', !isActive);
    }
}

window.toggleMode = () => {
    currentMode = currentMode === 'plan' ? 'build' : 'plan';
    document.body.classList.remove('mode-plan', 'mode-build');
    document.body.classList.add('mode-' + currentMode);
    modeToggle.classList.toggle('build', currentMode === 'build');
    document.getElementById('plan-btn').classList.toggle('active', currentMode === 'plan');
    document.getElementById('build-btn').classList.toggle('active', currentMode === 'build');
    vscode.postMessage({ type: 'updateMode', mode: currentMode });
    updateGromLogo();
    updateCapIcons();
};

let _inputHistory = [], _historyIdx = -1;
let _agentEnabled = false;
function _setAgentEnabled(enabled) {
    _agentEnabled = enabled;
    const btn = document.getElementById('agent-btn');
    if (btn) btn.classList.toggle('active', enabled);
}
window.toggleAgent = () => {
    _setAgentEnabled(!_agentEnabled);
    vscode.postMessage({ type: 'toggleAgent', enabled: _agentEnabled });
};

window.toggleHistory = () => { const overlay = document.getElementById('history-overlay'); overlay.style.display = overlay.style.display === 'flex' ? 'none' : 'flex'; };

window.switchHistoryTab = (tab) => {
  const isSessions = tab === 'sessions';
  document.getElementById('session-list').style.display = isSessions ? '' : 'none';
  const tlp = document.getElementById('task-log-panel');
  tlp.style.display = isSessions ? 'none' : 'flex';
  document.getElementById('tab-sessions').classList.toggle('active', isSessions);
  document.getElementById('tab-tasklog').classList.toggle('active', !isSessions);
};

function renderTaskLog(entries) {
  const list = document.getElementById('task-log-list');
  const empty = document.getElementById('task-log-empty');
  if (!entries || !entries.length) { empty.style.display = ''; list.innerHTML = ''; return; }
  empty.style.display = 'none';
  list.innerHTML = entries.slice().reverse().map(e => {
    const t = new Date(e.ts).toLocaleTimeString();
    const icon = { read_file:'📖', write_file:'✏️', list_directory:'📂', delete_file:'🗑️', search_files:'🔍', run_terminal:'⚡' }[e.tool] || '🔧';
    return `<div class="task-log-entry">
      <div class="task-log-header"><span>${icon} <code>${e.tool}</code></span><span class="task-log-time">${t}</span></div>
      ${e.argsSummary ? `<div class="task-log-args">${e.argsSummary}</div>` : ''}
      <div class="task-log-snippet">${e.snippet}</div>
    </div>`;
  }).join('');
  applyDeepLinks(list);
}

function appendTaskLogEntry(entry) {
  const list = document.getElementById('task-log-list');
  const empty = document.getElementById('task-log-empty');
  if (empty) empty.style.display = 'none';
  const t = new Date(entry.ts).toLocaleTimeString();
  const icon = { read_file:'📖', write_file:'✏️', list_directory:'📂', delete_file:'🗑️', search_files:'🔍', run_terminal:'⚡' }[entry.tool] || '🔧';
  const div = document.createElement('div'); div.className = 'task-log-entry';
  div.innerHTML = `<div class="task-log-header"><span>${icon} <code>${entry.tool}</code></span><span class="task-log-time">${t}</span></div>
    ${entry.argsSummary ? `<div class="task-log-args">${entry.argsSummary}</div>` : ''}
    <div class="task-log-snippet">${entry.snippet}</div>`;
  applyDeepLinks(div);
  if (list) list.prepend(div);
}

function linkifyPaths(text) {
  const pathRegex = /(?:\s|^)([\w\-][\w\-\/]*\.\w{1,8})(?:\s|$|[.,!?;])/g;
  return text.replace(pathRegex, (match, path) => {
    if (path.includes('/') || /\.(ts|js|py|md|json|html|css|go|rs|c|cpp|h|sh|tsx|jsx)$/i.test(path)) {
      return match.replace(path, `<span class="file-link" data-path="${path}">${path}</span>`);
    }
    return match;
  });
}

function applyDeepLinks(container) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
  const nodes = [];
  let node;
  while(node = walker.nextNode()) {
    if (!['CODE', 'PRE', 'BUTTON', 'A'].includes(node.parentElement.tagName) && !node.parentElement.closest('code')) {
      nodes.push(node);
    }
  }
  nodes.forEach(node => {
    const text = node.nodeValue;
    if (!text.trim()) return;
    const linked = linkifyPaths(text);
    if (linked !== text) {
      const span = document.createElement('span');
      span.innerHTML = linked;
      node.replaceWith(span);
    }
  });
}
function renderApprovalCard(m) {
  // Remove existing badge for this turn, replace with the card
  if (currentAiDiv) {
    const body = currentAiDiv.querySelector('.msg-body');
    body.querySelectorAll('.tool-call-badge').forEach(el => el.remove());
  }

  const toolIcons = { write_file:'✏️', delete_file:'🗑️', run_terminal:'⚡' };
  const icon = toolIcons[m.tool] || '🔧';
  const isWrite = m.tool === 'write_file';
  const isDelete = m.tool === 'delete_file';

  // Build args summary
  let argLines = '';
  for (const [k, v] of Object.entries(m.args || {})) {
    if (k === 'content') continue; // shown separately for write_file
    argLines += `<div class="approval-arg"><span class="approval-arg-key">${k}</span><code class="approval-arg-val">${String(v).slice(0, 120)}</code></div>`;
  }

  // Build content preview for write_file
  let diffHtml = '';
  if (isWrite && m.args.content) {
    const lines = m.args.content.split('\n').slice(0, 15);
    const more = m.args.content.split('\n').length > 15;
    diffHtml = `<div class="approval-preview">` +
      lines.map(l => `<div class="approval-line-add">+ ${escapeHtml(l)}</div>`).join('') +
      (more ? `<div class="approval-line-more">… (${m.args.content.split('\n').length} lines total)</div>` : '') +
      `</div>`;
    if (m.existingContent !== null && m.existingContent !== undefined) {
      // Show as diff (removed/added) up to 20 lines combined
      const oldLines = (m.existingContent || '').split('\n');
      const newLines = m.args.content.split('\n');
      diffHtml = buildMiniDiff(oldLines, newLines);
    }
  }

  const card = document.createElement('div');
  card.className = 'approval-card';
  card.dataset.id = m.id;
  card.innerHTML = `
    <div class="approval-header">
      <span class="approval-icon">${icon}</span>
      <span class="approval-tool">${m.tool}</span>
      <span class="approval-subtitle">${isDelete ? 'wants to delete a file' : isWrite ? (m.existingContent != null ? 'wants to modify a file' : 'wants to create a file') : 'wants to run a command'}</span>
    </div>
    <div class="approval-args">${argLines}</div>
    ${diffHtml}
    <div class="approval-actions">
      <button class="approval-btn approval-allow" onclick="respondApproval('${m.id}','allow')">Allow</button>
      <button class="approval-btn approval-allow-all" onclick="respondApproval('${m.id}','allowAll')">Allow All</button>
      <button class="approval-btn approval-deny" onclick="respondApproval('${m.id}','deny')">Deny</button>
      ${isWrite ? `<button class="approval-btn approval-diff" onclick="viewApprovalDiff('${m.id}')">View Diff</button>` : ''}
    </div>`;

  // Store content for the view diff button
  if (isWrite) { card.dataset.path = m.args.path || ''; card.dataset.content = m.args.content || ''; }

  if (currentAiDiv) {
    currentAiDiv.querySelector('.msg-body').appendChild(card);
  } else {
    chatContainer.appendChild(card);
  }
  applyDeepLinks(card);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function buildMiniDiff(oldLines, newLines) {
  // Very simple line diff: show removed lines (red) and added lines (green), cap at 20 total
  const MAX = 20;
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const removed = oldLines.filter(l => !newSet.has(l)).slice(0, MAX);
  const added = newLines.filter(l => !oldSet.has(l)).slice(0, MAX - removed.length);
  if (!removed.length && !added.length) {
    return `<div class="approval-preview"><div class="approval-line-more">No line changes detected (whitespace/formatting only)</div></div>`;
  }
  return `<div class="approval-preview">` +
    removed.map(l => `<div class="approval-line-remove">- ${escapeHtml(l)}</div>`).join('') +
    added.map(l => `<div class="approval-line-add">+ ${escapeHtml(l)}</div>`).join('') +
    `</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

window.respondApproval = (id, result) => {
  const card = document.querySelector(`.approval-card[data-id="${id}"]`);
  if (card) {
    const label = result === 'allow' ? '✓ Allowed' : result === 'allowAll' ? '✓ Allowed All' : '✕ Denied';
    const cls = result === 'deny' ? 'approval-resolved-deny' : 'approval-resolved-allow';
    card.innerHTML = `<div class="approval-resolved ${cls}">${label}: <code>${card.querySelector('.approval-tool')?.textContent || ''}</code></div>`;
  }
  vscode.postMessage({ type: 'toolApprovalResponse', id, result });
};

window.viewApprovalDiff = (id) => {
  const card = document.querySelector(`.approval-card[data-id="${id}"]`);
  if (!card) return;
  vscode.postMessage({ type: 'viewAgentDiff', path: card.dataset.path, content: card.dataset.content });
};

window.newSession = () => vscode.postMessage({ type: 'newSession' });
window.popIcon = (el) => { el.classList.remove('clicked'); void el.offsetWidth; el.classList.add('clicked'); el.addEventListener('animationend', () => el.classList.remove('clicked'), { once: true }); };
window.spinIcon = (el) => { const svg = el.querySelector('svg'); if (!svg) return; svg.classList.remove('spinning'); void svg.offsetWidth; svg.classList.add('spinning'); svg.addEventListener('animationend', () => svg.classList.remove('spinning'), { once: true }); };
window.compactSession = () => vscode.postMessage({ type: 'compactSession' });

function wireSessionListClicks() {
  const list = document.getElementById('session-list');
  if (!list) return;
  list.onclick = (ev) => {
    const del = ev.target.closest('[data-delete-id]');
    if (del) { ev.stopPropagation(); vscode.postMessage({ type: 'deleteSession', sessionId: del.dataset.deleteId }); return; }
    const ren = ev.target.closest('[data-rename-id]');
    if (ren) {
      ev.stopPropagation();
      const item = ren.closest('[data-session-id]');
      const titleEl = item.querySelector('.session-title');
      const oldTitle = titleEl.textContent;
      const input = document.createElement('input'); input.className = 'session-title-input'; input.value = oldTitle;
      titleEl.replaceWith(input); input.focus(); input.select();
      let finished = false;
      const outsideClick = (e) => { if (document.contains(input) && !item.contains(e.target)) finish(true); };
      document.addEventListener('mousedown', outsideClick);
      const finish = (save) => {
        if (finished) return; finished = true;
        _cancelActiveRename = null;
        document.removeEventListener('mousedown', outsideClick);
        const t = save && document.contains(input) ? (input.value.trim() || oldTitle) : oldTitle;
        if (document.contains(input)) {
          const newTitleEl = document.createElement('div'); newTitleEl.className = 'session-title'; newTitleEl.textContent = t;
          input.replaceWith(newTitleEl);
        }
        if (save && t !== oldTitle) vscode.postMessage({ type: 'renameSession', title: t, sessionId: ren.dataset.renameId });
      };
      _cancelActiveRename = () => finish(false);
      input.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { finish(false); }
      };
      return;
    }
    // Don't switch session if a rename is in progress
    if (_cancelActiveRename) return;
    const item = ev.target.closest('[data-session-id]');
    if (item) vscode.postMessage({ type: 'switchSession', sessionId: item.dataset.sessionId });
  };
}
window.setProvider = (v) => { if (v.startsWith('custom:')) { const [, url, fmt] = v.split(':'); vscode.postMessage({ type: 'changeProvider', providerId: 'custom', url, useOllamaFormat: fmt === '1' }); } else { vscode.postMessage({ type: 'changeProvider', providerId: v }); } };

function _updateKeyBtn(val, customProviders) {
  const btn = document.getElementById('api-key-btn');
  if (!btn) return;
  if (val.startsWith('custom:')) {
    const cp = customProviders?.[parseInt(val.split(':')[1])];
    const needsKey = cp && !cp.useOllamaFormat && (cp.authType || 'bearer') !== 'none';
    btn.style.display = needsKey ? '' : 'none';
    btn.dataset.providerName = cp?.name || '';
    btn.title = cp?.hasKey ? `Update API key for ${cp.name}` : `Set API key for ${cp.name}`;
    btn.style.opacity = cp?.hasKey ? '0.5' : '1';
  } else if (val === 'openai' || val === 'opencode' || val === 'anthropic' || val === 'groq' || val === 'mistral' || val === 'gemini') {
    btn.style.display = '';
    btn.dataset.providerId = val;
    delete btn.dataset.providerName;
    const labels = { openai: 'OpenAI', opencode: 'OpenCode', anthropic: 'Anthropic', groq: 'Groq', mistral: 'Mistral', gemini: 'Gemini' };
    btn.title = `Set API key for ${labels[val]}`;
    btn.style.opacity = '0.5';
  } else {
    btn.style.display = 'none';
  }
}

window.setProviderKey = () => {
  const btn = document.getElementById('api-key-btn');
  if (!btn) return;
  if (btn.dataset.providerName) {
    vscode.postMessage({ type: 'setProviderKey', providerName: btn.dataset.providerName });
  } else if (btn.dataset.providerId) {
    vscode.postMessage({ type: 'setProviderKey', providerId: btn.dataset.providerId });
  }
};
window.openSettings = () => vscode.postMessage({ type: 'openSettings' });

window.toggleSearch = () => {
  const bar = document.getElementById('search-bar');
  const visible = bar.style.display === 'flex';
  bar.style.display = visible ? 'none' : 'flex';
  if (!visible) { document.getElementById('search-input').focus(); }
  else { window.searchChat(''); }
};

window.searchChat = (query) => {
  const msgs = chatContainer.querySelectorAll('.msg');
  const q = query.trim().toLowerCase();
  let count = 0;
  msgs.forEach(msg => {
    msg.querySelectorAll('.search-highlight').forEach(el => { el.outerHTML = el.textContent; });
    if (!q) { msg.style.display = ''; return; }
    const text = msg.textContent.toLowerCase();
    if (text.includes(q)) {
      msg.style.display = '';
      count++;
      const body = msg.querySelector('.msg-body') || msg;
      body.innerHTML = body.innerHTML.replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark class="search-highlight">$1</mark>');
    } else { msg.style.display = 'none'; }
  });
  document.getElementById('search-count').textContent = q ? `${count} result${count !== 1 ? 's' : ''}` : '';
};
window.doneMemory = () => {
  const memory = document.getElementById('memory-editor').value;
  vscode.postMessage({ type: 'saveMemory', memory });
  document.getElementById('memory-overlay').style.display = 'none';
};
window.cancelMemory = () => {
  document.getElementById('memory-editor').value = _memoryOriginal;
  vscode.postMessage({ type: 'saveMemory', memory: _memoryOriginal });
  document.getElementById('memory-overlay').style.display = 'none';
};
window.onMemoryInput = () => {
  const text = document.getElementById('memory-editor').value;
  const tokens = Math.ceil(text.length / 4);
  document.getElementById('memory-counter').textContent = text.length ? `~${tokens} tokens` : '';
  clearTimeout(_memorySaveTimer);
  _memorySaveTimer = setTimeout(() => vscode.postMessage({ type: 'saveMemory', memory: text }), 800);
};
function _setMemoryDot(hasMemory) {
  const btn = document.getElementById('memory-btn');
  if (btn) btn.classList.toggle('has-memory', !!hasMemory);
}
function _setSysPromptDot(hasPrompt) {
  const btn = document.getElementById('sysprompt-btn');
  if (btn) btn.classList.toggle('has-prompt', !!hasPrompt);
}
window.closeSysPrompt = () => { document.getElementById('sysprompt-overlay').style.display = 'none'; };
window.saveSysPrompt = () => { vscode.postMessage({ type: 'setSystemPrompt', prompt: document.getElementById('sysprompt-editor').value }); };
window.retryConnection = () => vscode.postMessage({ type: 'retryConnection' });
window.openSettings = () => {
  const overlay = document.getElementById('settings-overlay');
  if (overlay.style.display === 'flex') { overlay.style.display = 'none'; return; }
  overlay.style.display = 'flex';
  document.getElementById('test-conn-result').textContent = '';
  document.getElementById('mcp-tool-list').textContent = 'Loading…';
  document.getElementById('mcp-tool-count').textContent = '';
  vscode.postMessage({ type: 'getMcpStatus' });
};
window.closeSettings = () => { document.getElementById('settings-overlay').style.display = 'none'; };
window.testConnection = () => {
  const btn = document.getElementById('test-conn-btn');
  const result = document.getElementById('test-conn-result');
  btn.disabled = true; btn.textContent = 'Testing…';
  result.textContent = ''; result.style.color = '';
  vscode.postMessage({ type: 'testConnection' });
};

window.startEditingTitle = () => {
    const container = document.getElementById('current-title-container');
    const existing = document.getElementById('title-editor'); if (existing) return; // already editing
    const oldTitle = (document.getElementById('current-title') || {}).textContent || 'Untitled';
    container.onclick = null;
    container.innerHTML = `<input type="text" class="title-input" id="title-editor" value="${oldTitle}">`;
    const input = document.getElementById('title-editor'); input.focus(); input.select();
    let _titleFinished = false;
    const finish = (save) => {
      if (_titleFinished) return; _titleFinished = true;
      document.removeEventListener('mousedown', _titleOutsideClick);
      const newTitle = save ? (input.value.trim() || oldTitle) : oldTitle;
      container.innerHTML = `<span id="current-title">${newTitle}</span>`;
      container.onclick = window.startEditingTitle;
      if (save) vscode.postMessage({ type: 'renameSession', title: newTitle, sessionId: _currentSessionId });
    };
    const _titleOutsideClick = (e) => { if (!container.contains(e.target)) finish(true); };
    document.addEventListener('mousedown', _titleOutsideClick);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { finish(false); }
    };
};

window.copyMsg = (btn) => {
    const msgBody = btn.closest('.msg').querySelector('.msg-body');
    navigator.clipboard.writeText(msgBody.innerText);
    const original = btn.innerHTML; btn.innerHTML = '<span>✓ Copied</span>';
    setTimeout(() => btn.innerHTML = original, 2000);
};

function renderMsg(role, content, images = []) {
  const div = document.createElement('div'); div.className = 'msg ' + role;
  const body = document.createElement('div'); body.className = 'msg-body';
  if (role === 'user') {
      body.textContent = content;
      images.forEach(img => { const imgEl = document.createElement('img'); imgEl.src = 'data:image/jpeg;base64,' + img; imgEl.style.cssText = 'max-width:100%;border-radius:8px;display:block;margin-top:6px'; body.appendChild(imgEl); });
      div.appendChild(body);
      const actions = document.createElement('div'); actions.className = 'msg-actions msg-actions-user';
      const resendBtn = document.createElement('button'); resendBtn.className = 'action-text-btn resend-btn';
      resendBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 .49-3.51"></path></svg> Resend`;
      resendBtn.onclick = () => { vscode.postMessage({ type: 'resend' }); };
      actions.appendChild(resendBtn);
      div.appendChild(actions);
      chatContainer.querySelectorAll('.resend-btn').forEach(b => { b.style.display = 'none'; });
      resendBtn.style.display = '';
  } else {
      updateAiDisplay(body, content); div.appendChild(body);
      const actions = document.createElement('div'); actions.className = 'msg-actions';
      actions.innerHTML = `<button class="action-text-btn" onclick="window.copyMsg(this)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy</button>`;
      div.appendChild(actions);
  }
  chatContainer.appendChild(div); chatContainer.scrollTop = chatContainer.scrollHeight;
  document.getElementById('empty-state').style.display = 'none'; document.getElementById('mini-grom')?.classList.add('visible'); return div;
}

function updateAiDisplay(container, text) {
  if (text.includes('<think>')) {
      const parts = text.split(/<\/think>/), think = parts[0].replace('<think>', '').trim(), main = parts[1] || "";
      container.innerHTML = '<div class="think">' + (think ? marked.parse(think) : '') + '</div>' + marked.parse(main);
  } else { container.innerHTML = marked.parse(text); }
  container.querySelectorAll('pre').forEach(pre => {
      const code = pre.querySelector('code').innerText, header = document.createElement('div'); header.className = 'code-header';
      // Detect if the preceding sibling heading looks like a file path (### path/to/file.ext)
      // Only show write-oriented buttons (Diff/Apply/Accept/Reject) for those blocks
      const prevEl = pre.previousElementSibling;
      const isFileSuggestion = prevEl && /h[1-6]/i.test(prevEl.tagName) && /[\w\-]+\.\w+/.test(prevEl.textContent);
      if (isFileSuggestion) {
        ['Diff', 'Apply'].forEach(label => {
          const btn = document.createElement('button'); btn.className = 'code-btn'; btn.textContent = label;
          btn.onclick = () => vscode.postMessage({ type: label.toLowerCase() + 'Code', code }); header.appendChild(btn);
        });
      }
      const insertBtn = document.createElement('button'); insertBtn.className = 'code-btn'; insertBtn.textContent = 'Insert';
      insertBtn.onclick = () => vscode.postMessage({ type: 'insertCode', code }); header.appendChild(insertBtn);
      const runBtn = document.createElement('button'); runBtn.className = 'code-btn'; runBtn.textContent = 'Run';
      runBtn.onclick = () => vscode.postMessage({ type: 'runInTerminal', code }); header.appendChild(runBtn);
      const copyBtn = document.createElement('button'); copyBtn.className = 'code-btn'; copyBtn.textContent = 'Copy';
      copyBtn.onclick = () => { navigator.clipboard.writeText(code); copyBtn.textContent = '✓'; setTimeout(() => copyBtn.textContent = 'Copy', 1500); }; header.appendChild(copyBtn);
      if (isFileSuggestion) {
        const acceptBtn = document.createElement('button'); acceptBtn.className = 'code-btn code-btn-accept'; acceptBtn.textContent = '✓ Accept';
        acceptBtn.onclick = () => { vscode.postMessage({ type: 'acceptDiff', code }); acceptBtn.textContent = '✓ Applied'; acceptBtn.disabled = true; };
        const rejectBtn = document.createElement('button'); rejectBtn.className = 'code-btn code-btn-reject'; rejectBtn.textContent = '✕ Reject';
        rejectBtn.onclick = () => { acceptBtn.disabled = true; rejectBtn.disabled = true; acceptBtn.textContent = 'Rejected'; };
        header.appendChild(acceptBtn); header.appendChild(rejectBtn);
      }
      pre.prepend(header); hljs.highlightElement(pre.querySelector('code'));
  });
  // Detect ### path/to/file.ext headings — add a "Save as file" button to the following code block
  container.querySelectorAll('h3, h4').forEach(heading => {
    const filePath = heading.textContent.trim();
    if (!/[\w\-][\w\-\/]*\.\w{1,8}$/.test(filePath)) return;
    let next = heading.nextElementSibling;
    while (next && next.tagName !== 'PRE') next = next.nextElementSibling;
    if (!next) return;
    const code = next.querySelector('code')?.innerText || '';
    const existingHeader = next.querySelector('.code-header');
    if (!existingHeader) return;
    const saveBtn = document.createElement('button');
    saveBtn.className = 'code-btn code-btn-accept';
    saveBtn.textContent = '💾 Save';
    saveBtn.title = `Save as ${filePath}`;
    saveBtn.onclick = () => {
      vscode.postMessage({ type: 'createFile', path: filePath, content: code });
      saveBtn.textContent = '✓ Saved'; saveBtn.disabled = true;
    };
    existingHeader.appendChild(saveBtn);
  });
  applyDeepLinks(container);
}

sendBtn.onclick = () => {
  const val = prompt.value.trim(); if (!val && !pendingImages.length && !uploadedContext.length) return;
  if (pendingImages.length > 0 && _currentCaps && !_currentCaps.vision) {
    const warn = document.createElement('div');
    warn.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--vscode-inputValidation-warningBackground,#5a4a00);color:var(--text);padding:6px 14px;border-radius:6px;font-size:12px;z-index:999;pointer-events:none;opacity:1;transition:opacity 0.4s';
    warn.textContent = 'This model may not support images';
    document.body.appendChild(warn);
    setTimeout(() => { warn.style.opacity = '0'; setTimeout(() => warn.remove(), 400); }, 2000);
  }
  // Intercept /compact before sending to the model
  if (val.toLowerCase() === '/compact') { prompt.value = ''; window.compactSession(); return; }
  if (val.toLowerCase() === '/clear-history') { prompt.value = ''; _inputHistory = []; _historyIdx = -1; vscode.postMessage({ type: 'clearPromptHistory' }); const note = renderMsg('ai', '*Prompt history cleared.*'); return; }
  renderMsg('user', val, [...pendingImages]);
  let fullText = val; if (uploadedContext.length > 0) { fullText += "\n\nADDITIONAL UPLOADED CONTEXT:\n" + uploadedContext.map(u => `[File: ${u.name}]\n${u.content}`).join('\n\n'); }
  vscode.postMessage({ type: 'send', text: fullText, images: [...pendingImages], mode: currentMode });
  if (val && (_inputHistory.length === 0 || _inputHistory[_inputHistory.length - 1] !== val)) { _inputHistory.push(val); if (_inputHistory.length > 50) _inputHistory.shift(); }
  _historyIdx = -1;
  prompt.value = ''; currentAiText = ""; currentAiDiv = renderMsg('ai', '');
  currentAiDiv.querySelector('.msg-body').innerHTML = '<div class="thinking-dots"><span></span><span></span><span></span><span class="elapsed-time"></span></div>';
  _startElapsedTimer(currentAiDiv.querySelector('.thinking-dots'));
  _requestId++;
  const _thisRequestId = _requestId;
  currentAiDiv._requestId = _thisRequestId;
  sendBtn.style.display = 'none'; stopBtn.style.display = 'flex';
  document.body.classList.add('grom-thinking'); updateGromLogo();
  pendingImages = []; uploadedContext = []; document.getElementById('image-preview').innerHTML = '';
  document.getElementById('context-row').innerHTML = ''; prompt.style.height = 'auto';
};

stopBtn.onclick = () => {
  vscode.postMessage({ type: 'abort' });
  // Re-enable send immediately so the user can type a follow-up without waiting for Ready
  sendBtn.style.display = 'flex'; stopBtn.style.display = 'none'; document.body.classList.remove('grom-thinking'); updateGromLogo();
  if (currentAiDiv) {
    _stopElapsedTimer(); currentAiDiv.querySelector('.thinking-dots')?.remove();
    if (!currentAiText.trim()) currentAiDiv.querySelector('.msg-body').textContent = '*Cancelled.*';
  }
};
let _slashMenuIdx = -1;
function _slashVisible() { return slashMenu.style.display === 'flex'; }
function _slashItems() { return Array.from(slashMenu.querySelectorAll('.menu-item')).filter(i => i.style.display !== 'none'); }
function _slashHighlight() { _slashItems().forEach((el, i) => el.classList.toggle('active', i === _slashMenuIdx)); }
prompt.oninput = () => {
  resetIdle(true); _historyIdx = -1; prompt.style.height = 'auto'; prompt.style.height = prompt.scrollHeight + 'px';
  if (prompt.value.startsWith('/')) {
    const filter = prompt.value.slice(1).toLowerCase();
    let any = false;
    slashMenu.querySelectorAll('.menu-item').forEach(item => {
      const match = filter === '' || (item.dataset.cmd || '').startsWith(filter) || (item.dataset.cmdAlt || '').startsWith(filter);
      item.style.display = match ? '' : 'none';
      if (match) any = true;
    });
    window.toggleSlashMenu(any);
    _slashMenuIdx = any ? 0 : -1;
    _slashHighlight();
  } else { window.toggleSlashMenu(false); }
};
prompt.addEventListener('blur', () => { _historyIdx = -1; });
prompt.onkeydown = (e) => {
  resetIdle(true);
  if (_slashVisible()) {
    const items = _slashItems();
    if (e.key === 'ArrowDown') { e.preventDefault(); _slashMenuIdx = Math.min(_slashMenuIdx + 1, items.length - 1); _slashHighlight(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); _slashMenuIdx = Math.max(_slashMenuIdx - 1, 0); _slashHighlight(); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && _slashMenuIdx >= 0)) {
      const target = items[_slashMenuIdx] ?? items[0];
      if (target) { e.preventDefault(); target.click(); return; }
    }
    if (e.key === 'Escape') { e.preventDefault(); window.toggleSlashMenu(false); return; }
  }
  if (e.key === 'ArrowUp' && !e.shiftKey && (prompt.value === '' || _historyIdx >= 0)) {
    if (_historyIdx === -1 && _inputHistory.length > 0) { _historyIdx = _inputHistory.length - 1; }
    else if (_historyIdx > 0) { _historyIdx--; }
    if (_historyIdx >= 0) { e.preventDefault(); prompt.value = _inputHistory[_historyIdx]; prompt.style.height = 'auto'; prompt.style.height = prompt.scrollHeight + 'px'; }
    return;
  }
  if (e.key === 'ArrowDown' && !e.shiftKey && _historyIdx >= 0) {
    e.preventDefault();
    if (_historyIdx < _inputHistory.length - 1) { _historyIdx++; prompt.value = _inputHistory[_historyIdx]; }
    else { _historyIdx = -1; prompt.value = ''; }
    prompt.style.height = 'auto'; prompt.style.height = prompt.scrollHeight + 'px';
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.onclick(); }
};

prompt.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile(); if (!file) continue;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const b64 = ev.target.result.split(',')[1]; pendingImages.push(b64);
        const div = document.createElement('div'); div.className = 'preview-item';
        const img = document.createElement('img'); img.src = ev.target.result; img.className = 'img-preview-img';
        const rm = document.createElement('span'); rm.className = 'img-remove-btn'; rm.textContent = '×';
        rm.onclick = () => { div.remove(); const idx = pendingImages.indexOf(b64); if (idx >= 0) pendingImages.splice(idx, 1); };
        div.appendChild(img); div.appendChild(rm);
        document.getElementById('image-preview').appendChild(div);
      };
      reader.readAsDataURL(file);
    }
  }
});

window.toggleSlashMenu = (show) => { slashMenu.style.display = show ? 'flex' : 'none'; if (show) plusMenu.style.display = 'none'; };
window.openSlashMenu = () => { slashMenu.querySelectorAll('.menu-item').forEach(i => { i.style.display = ''; i.classList.remove('active'); }); _slashMenuIdx = -1; window.toggleSlashMenu(true); };
window.togglePlusMenu = () => { plusMenu.style.display = plusMenu.style.display === 'flex' ? 'none' : 'flex'; slashMenu.style.display = 'none'; };
document.addEventListener('mousedown', (e) => {
    resetIdle(true);
    if (!slashMenu.contains(e.target) && !document.getElementById('slash-btn').contains(e.target)) window.toggleSlashMenu(false);
    if (!plusMenu.contains(e.target) && !document.getElementById('plus-btn').contains(e.target)) plusMenu.style.display = 'none';
});

let idleTimer = null, thoughtInterval = null, mouseCenterTimer = null, rotationCount = 0;
const THOUGHTS = ['10101', '</%>', 'JSON...', '0xAFF', 'if(true)', 'thinking...', 'byte[]'];

function getEyes() { return [document.getElementById('eye-left'), document.getElementById('eye-right')].filter(Boolean); }

function resetIdle(forceWake = false) {
    const logo = document.getElementById('main-logo'), bubble = document.getElementById('thought-bubble');
    const eyes = getEyes();
    const isAsleep = eyes.length > 0 && eyes[0].classList.contains('asleep');
    if (bubble) bubble.classList.remove('active');
    clearInterval(thoughtInterval); thoughtInterval = null;
    if (!robotAnimations) { eyes.forEach(e => e.classList.remove('asleep')); return; }
    if (isAsleep && !forceWake) return;
    clearTimeout(mouseCenterTimer);
    if (isAsleep && logo && forceWake) {
        logo.classList.add('surprised'); const mark = document.createElement('div'); mark.className = 'startle-mark active'; mark.textContent = '!!';
        logo.appendChild(mark); setTimeout(() => { logo.classList.remove('surprised'); mark.remove(); }, 600);
    }
    eyes.forEach(e => { e.classList.remove('asleep'); e.style.transform = ''; });
    clearTimeout(idleTimer); rotationCount = 0; idleTimer = setTimeout(showThoughts, 15000);
}

function showThoughts() {
    if (!robotAnimations) return;
    vscode.postMessage({ type: 'idleStart' });
    const logo = document.getElementById('main-logo'); if (!logo || thoughtInterval) return;
    let bubble = document.getElementById('thought-bubble');
    if (!bubble) { bubble = document.createElement('div'); bubble.id = 'thought-bubble'; bubble.className = 'thought-bubble'; logo.appendChild(bubble); }
    bubble.classList.add('active'); let idx = 0; bubble.textContent = THOUGHTS[0];
    thoughtInterval = setInterval(() => {
        idx++;
        if (idx >= THOUGHTS.length) {
            idx = 0; rotationCount++;
            if (rotationCount >= 2) {
                bubble.textContent = 'zzZZ...';
                getEyes().forEach(e => { e.style.transform = 'scaleY(0.5)'; });
                setTimeout(() => { getEyes().forEach(e => { e.style.transform = 'scaleY(0.2) scaleX(1.2)'; }); }, 400);
                setTimeout(() => { getEyes().forEach(e => { e.style.transform = ''; e.classList.add('asleep'); }); }, 800);
                clearInterval(thoughtInterval); thoughtInterval = null; return;
            }
        }
        bubble.textContent = THOUGHTS[idx];
    }, 2000);
}

document.addEventListener('mouseleave', () => { mouseCenterTimer = setTimeout(() => { getEyes().forEach(e => e.style.transform = ''); }, 5000); });
document.addEventListener('mouseenter', () => clearTimeout(mouseCenterTimer));
document.addEventListener('mousemove', (e) => {
    if (!robotAnimations) return;
    const eyes = getEyes();
    if (!eyes.length) return;
    if (eyes[0].classList.contains('asleep')) return;
    resetIdle();
    const logo = document.getElementById('main-logo');
    if (!logo) return;
    const rect = logo.getBoundingClientRect();
    if (!rect.width) return;
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const angle = Math.atan2(e.clientY - cy, e.clientX - cx);
    const dist = Math.min(40, Math.hypot(e.clientX - cx, e.clientY - cy) / 1);
    eyes.forEach(eye => { eye.style.transform = `translate(${Math.cos(angle) * dist}px, ${Math.sin(angle) * dist}px)`; });
});

window.insertSlash = (cmd) => {
    if (cmd.startsWith('/')) prompt.value = cmd + ' '; else prompt.value = cmd;
    window.toggleSlashMenu(false); prompt.focus(); prompt.style.height = 'auto'; prompt.style.height = prompt.scrollHeight + 'px';
};

function updateContextChips(files) {
    const row = document.getElementById('context-row'); row.innerHTML = '';
    files.forEach(f => {
        const chip = document.createElement('div'); chip.className = 'context-chip';
        const t = f.tokens > 1000 ? (f.tokens/1000).toFixed(1) + 'k' : f.tokens;
        chip.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg><span>${f.name}</span><span style="opacity:0.5; font-size:9px; margin-left:2px;">${t}</span>`;
        row.appendChild(chip);
    });
    uploadedContext.forEach((u, i) => {
        const chip = document.createElement('div'); chip.className = 'context-chip';
        const t = Math.ceil(u.content.length / 4);
        const ts = t > 1000 ? (t/1000).toFixed(1) + 'k' : t;
        chip.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg><span>${u.name}</span><span style="opacity:0.5; font-size:9px; margin-left:2px;">${ts}</span><span class="chip-remove" onclick="removeUploaded(${i})">×</span>`;
        row.appendChild(chip);
    });
}

window.removeUploaded = (i) => { uploadedContext.splice(i, 1); updateContextChips(_lastAutoFiles); };

function handleFileUpload(input) {
    if (input.files && input.files[0]) {
        const file = input.files[0], reader = new FileReader();
        if (file.type.startsWith('image/')) {
            reader.onload = (e) => {
                const b64 = e.target.result.split(',')[1]; pendingImages.push(b64);
                const div = document.createElement('div'); div.className = 'preview-item';
                const img = document.createElement('img'); img.src = e.target.result; img.className = 'img-preview-img';
                const rm = document.createElement('span'); rm.className = 'img-remove-btn'; rm.textContent = '×';
                rm.onclick = () => { div.remove(); const idx = pendingImages.indexOf(b64); if (idx >= 0) pendingImages.splice(idx, 1); };
                div.appendChild(img); div.appendChild(rm);
                document.getElementById('image-preview').appendChild(div);
            };
            reader.readAsDataURL(file);
        } else {
            reader.onload = (e) => { uploadedContext.push({ name: file.name, content: e.target.result }); vscode.postMessage({ type: 'getFiles' }); };
            reader.readAsText(file);
        }
    }
}

// ── Voice input ──────────────────────────────────────────────────────────────
// Audio capture: ffmpeg subprocess in extension host → raw 16kHz PCM → sent here as base64.
// Inference: Whisper via @huggingface/transformers CDN, runs in an inline blob Worker.

let _voiceRecordingTimer = null;
function _setVoiceState(state) {
  _voiceState = state;
  const btn = document.getElementById('mic-btn');
  if (!btn) return;
  if (_voiceRecordingTimer) { clearTimeout(_voiceRecordingTimer); _voiceRecordingTimer = null; }
  btn.classList.remove('recording', 'transcribing');
  if (state === 'recording') {
    // Small delay so the button doesn't flash before audio actually starts flowing
    _voiceRecordingTimer = setTimeout(() => { btn.classList.add('recording'); _voiceRecordingTimer = null; }, 150);
  } else if (state === 'transcribing') {
    btn.classList.add('transcribing');
  }
  if (state === 'transcribing') _vpSetTranscribingRow('Transcribing');
  else if (state === 'idle') _vpSetTranscribingRow(null);
}

function _vpSetTranscribingRow(text) {
  const row = document.getElementById('voice-transcribing-row');
  if (!row) return;
  row.style.display = text ? 'flex' : 'none';
  if (text) {
    const span = document.getElementById('voice-transcribing-text');
    if (span) span.textContent = text;
  }
}

function _setVoiceDownload(text) {
  const row = document.getElementById('voice-download-row');
  const span = document.getElementById('voice-download-text');
  if (!row || !span) return;
  if (text) { span.textContent = text; row.style.display = 'flex'; }
  else { row.style.display = 'none'; }
}

// ── Whisper inference — runs in a Web Worker to keep the UI thread free ───────
let _vpWorker = null, _vpAllPcm = null, _vpBusy = false, _vpPendingFinal = false, _vpTranscribedText = '';
let _vpWarming = false; // suppresses worker progress messages during silent startup pre-load

function _vpInjectToPrompt(text) {
  const p = document.getElementById('prompt');
  if (p) { p.value = text; p.dispatchEvent(new Event('input')); p.focus(); }
}

function _vpFlashResult(text, ms) {
  const res = document.getElementById('clear-voice-result');
  if (res) { res.textContent = text; setTimeout(() => { res.textContent = ''; }, ms); }
}

function _vpMaybeWarmUp() {
  if (!_voiceInputEnabled || !_vpGetDownloaded().includes(_vpModelId)) return;
  _vpWarming = true; _vpSetTranscribingRow('Warming up…');
  _vpGetWorker().then(w => w.postMessage({ type: 'load', modelId: _vpModelId }))
    .catch(() => { _vpWarming = false; _vpSetTranscribingRow(null); });
}
let _vpModelId = 'tiny.en';   // active/default model used for transcription
let _vpSelectedId = 'tiny.en'; // currently highlighted in the picker UI
let _vpEnergyGate = 0.010;    // RMS threshold — audio below this is treated as silence

function _vpGetDownloaded() {
  try { return JSON.parse(localStorage.getItem('grom_downloaded_models') || '[]'); } catch { return []; }
}
function _vpMarkDownloaded(modelId) {
  try {
    const set = new Set(_vpGetDownloaded());
    set.add(modelId);
    localStorage.setItem('grom_downloaded_models', JSON.stringify([...set]));
  } catch {}
}
function _vpClearDownloaded() {
  try { localStorage.removeItem('grom_downloaded_models'); } catch {}
}

const _VP_MODEL_INFO = {
  'tiny':     { hf: 'Xenova/whisper-tiny',     note: 'Multilingual · ~40 MB' },
  'tiny.en':  { hf: 'Xenova/whisper-tiny.en',  note: 'English · ~40 MB' },
  'base':     { hf: 'Xenova/whisper-base',     note: 'Multilingual · ~74 MB' },
  'base.en':  { hf: 'Xenova/whisper-base.en',  note: 'English · ~74 MB' },
  'small.en': { hf: 'Xenova/whisper-small.en', note: 'English · ~244 MB — best accuracy' },
  'small':    { hf: 'Xenova/whisper-small',    note: 'Multilingual · ~244 MB' },
};

const _VP_MODEL_LABELS = { 'tiny': 'Tiny', 'tiny.en': 'Tiny EN', 'base': 'Base', 'base.en': 'Base EN', 'small.en': 'Small EN', 'small': 'Small' };

function _vpUpdateModelUI() {
  const downloaded = new Set(_vpGetDownloaded());
  Object.keys(_VP_MODEL_INFO).forEach(id => {
    const btn = document.getElementById('voice-model-btn-' + id);
    if (!btn) return;
    const isSelected = id === _vpSelectedId;  // highlighted in picker
    const isDefault  = id === _vpModelId;      // actual active model
    const isDownloaded = downloaded.has(id);
    btn.classList.toggle('active', isSelected);
    btn.classList.toggle('loaded', isDownloaded && !isSelected);
    const label = _VP_MODEL_LABELS[id] || id;
    const sizePart = _VP_MODEL_INFO[id].note.match(/~\d+ MB/)?.[0] || '';
    const badge = isDefault ? ' ●' : (isDownloaded ? ' ✓' : '');
    btn.textContent = label + (sizePart ? ' · ' + sizePart : '') + badge;
    btn.title = isDefault ? 'Default model — used for transcription' : (isDownloaded ? 'Downloaded — click to select, then set as default' : 'Not downloaded');
  });

  // Desc line: always describes the highlighted (selected) model
  const selInfo = _VP_MODEL_INFO[_vpSelectedId] || _VP_MODEL_INFO['tiny.en'];
  const selLabel = _VP_MODEL_LABELS[_vpSelectedId] || _vpSelectedId;
  const selDownloaded = downloaded.has(_vpSelectedId);
  const isAlreadyDefault = _vpSelectedId === _vpModelId;
  const desc = document.getElementById('voice-model-desc');
  if (desc) {
    if (isAlreadyDefault && selDownloaded) desc.textContent = '● Default: ' + selLabel + ' · ' + selInfo.note;
    else if (selDownloaded) desc.textContent = selLabel + ' · ' + selInfo.note + ' · downloaded';
    else desc.textContent = selLabel + ' · ' + selInfo.note + ' · not downloaded';
  }

  // Download button — for selected model if not downloaded
  const dlBtn = document.getElementById('voice-model-download-btn');
  if (dlBtn) {
    dlBtn.style.display = selDownloaded ? 'none' : '';
    dlBtn.textContent = 'Download ' + selLabel;
    dlBtn.disabled = false;
  }

  // "Set as default" button — shown when selected is downloaded but not the default
  const defBtn = document.getElementById('voice-set-default-btn');
  if (defBtn) {
    defBtn.style.display = (selDownloaded && !isAlreadyDefault) ? '' : 'none';
    defBtn.textContent = 'Set as default';
  }
}

let _vpWorkerPromise = null;

function _vpMakeWorker() {
  // Inline the worker code to avoid vscode-resource origin issues entirely.
  // Classic worker (no type:module) — dynamic import() is sufficient.
  const src = `
const MODEL_INFO = {
  'tiny':     'Xenova/whisper-tiny',
  'tiny.en':  'Xenova/whisper-tiny.en',
  'base':     'Xenova/whisper-base',
  'base.en':  'Xenova/whisper-base.en',
  'small.en': 'Xenova/whisper-small.en',
  'small':    'Xenova/whisper-small',
};
const CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/+esm';
let _pipe = null;
let _loadedModel = null;

self.onunhandledrejection = function(e) {
  self.postMessage({ type: 'error', message: 'Unhandled: ' + ((e.reason && e.reason.message) || String(e.reason)) });
};

async function _load(modelId) {
  if (_loadedModel === modelId && _pipe) return _pipe;
  _pipe = null; _loadedModel = null;
  const hf = MODEL_INFO[modelId] || MODEL_INFO['tiny.en'];
  self.postMessage({ type: 'progress', text: 'Loading pipeline…' });
  const mod = await import(CDN);
  const pipeline = mod.pipeline;
  _pipe = await pipeline('automatic-speech-recognition', hf, {
    dtype: 'q8',
    progress_callback: function(p) {
      if (p.status === 'downloading')
        self.postMessage({ type: 'progress', text: p.total
          ? 'Downloading model… ' + Math.round(p.loaded / p.total * 100) + '%'
          : 'Downloading model…' });
      else if (p.status === 'loading')
        self.postMessage({ type: 'progress', text: 'Loading model…' });
    }
  });
  _loadedModel = modelId;
  self.postMessage({ type: 'ready', modelId: modelId });
  return _pipe;
}

self.onmessage = async function(e) {
  const d = e.data;
  if (d.type === 'load') {
    try { await _load(d.modelId); }
    catch(err) { self.postMessage({ type: 'error', message: err.message }); }
    return;
  }
  if (d.type === 'transcribe') {
    try {
      const pipe = await _load(d.modelId);
      self.postMessage({ type: 'progress', text: null });
      const audio = new Float32Array(d.pcm);
      const opts = { sampling_rate: 16000 };
      if (d.isMultilingual) opts.language = 'english';
      const result = await pipe(audio, opts);
      const text = (Array.isArray(result) ? (result[0] && result[0].text) : result && result.text) || '';
      self.postMessage({ type: 'result', text: text, isFinal: d.isFinal });
    } catch(err) {
      self.postMessage({ type: 'error', message: err.message, isFinal: d.isFinal });
    }
  }
};
`;
  const blob = new Blob([src], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  console.log('[grom voice] creating inline blob worker');
  const w = new Worker(url);
  URL.revokeObjectURL(url);
  w.onmessage = _vpOnWorkerMessage;
  w.onerror = e => {
    console.error('[grom voice] worker onerror:', e.message, e);
    _setVoiceDownload('⚠ Worker error: ' + e.message);
    _vpBusy = false;
    _vpWorker = null;
    _setVoiceState('idle');
  };
  return w;
}

async function _vpGetWorker() {
  if (_vpWorker) return _vpWorker;
  if (_vpWorkerPromise) return _vpWorkerPromise;
  console.log('[grom voice] _vpGetWorker: creating new worker');
  _vpWorkerPromise = Promise.resolve().then(() => {
    _vpWorker = _vpMakeWorker();
    _vpWorkerPromise = null;
    return _vpWorker;
  });
  return _vpWorkerPromise;
}

function _vpOnWorkerMessage(e) {
  const { type, text, isFinal, modelId, message } = e.data;
  if (type === 'progress') {
    if (!_vpWarming) _setVoiceDownload(text); // suppress during silent warm-up
    return;
  }
  if (type === 'ready') {
    _vpWarming = false;
    _vpMarkDownloaded(modelId);
    _vpUpdateModelUI();
    _vpSetTranscribingRow(null); // clear "Warming up" if shown
    _setVoiceDownload('✓ Model ready');
    setTimeout(() => _setVoiceDownload(null), 2500);
    return;
  }
  if (type === 'result') {
    console.log('[grom voice] worker result:', JSON.stringify(text));
    if (text && text.trim() && !_vpIsLooping(text)) {
      _vpTranscribedText = _vpTranscribedText ? _vpTranscribedText + ' ' + text.trim() : text.trim();
      _vpInjectToPrompt(_vpTranscribedText);
    } else if (_vpIsLooping(text)) {
      console.warn('[grom voice] repetition loop detected, discarding');
    }
    _vpBusy = false;
    if (_vpPendingFinal) { _vpPendingFinal = false; _vpTranscribe(true); }
    else if (isFinal) { _setVoiceState('idle'); _setVoiceDownload(null); }
    return;
  }
  if (type === 'error') {
    console.error('[grom voice] worker inference error:', message);
    if (isFinal) _setVoiceDownload('⚠ ' + message);
    _vpBusy = false;
    _setVoiceState('idle');
  }
}

// Highlight a model in the picker — does not change the active model
window.selectVoiceModel = function(id) {
  _vpSelectedId = id;
  _vpUpdateModelUI();
};

// Promote the highlighted model to active default
window.applyVoiceModel = function() {
  const id = _vpSelectedId;
  if (id === _vpModelId) return;
  _vpModelId = id;
  if (_vpWorker) { _vpWorker.terminate(); _vpWorker = null; _vpWorkerPromise = null; }
  _vpBusy = false;
  _vpPendingFinal = false;
  _vpAllPcm = null;
  _vpUpdateModelUI();
  vscode.postMessage({ type: 'setVoiceModel', model: id });
};

window.downloadVoiceModel = async function() {
  const targetModel = _vpSelectedId; // download the highlighted model
  console.log('[grom voice] download:', targetModel);
  const dlBtn = document.getElementById('voice-model-download-btn');
  if (dlBtn) { dlBtn.disabled = true; dlBtn.textContent = 'Downloading…'; }
  try {
    const worker = await _vpGetWorker();
    worker.postMessage({ type: 'load', modelId: targetModel });
  } catch (err) {
    console.error('[grom voice] downloadVoiceModel failed:', err);
    _vpUpdateModelUI();
  }
};

// Whisper's context window is 30s — beyond this it loops. Cap hard at 28s to be safe.
const _VP_MAX_SAMPLES = 16000 * 28;
// Silence prepended to each utterance — Whisper often drops the first word without it.
const _VP_PAD = 16000 * 0.3 | 0;

function _vpRms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

// Detect Whisper repetition loops: a word repeated 4+ times consecutively
function _vpIsLooping(text) {
  const words = text.trim().split(/\s+/);
  if (words.length < 4) return false;
  for (let i = 0; i <= words.length - 4; i++) {
    if (words[i] === words[i+1] && words[i] === words[i+2] && words[i] === words[i+3]) return true;
  }
  return false;
}

async function _vpTranscribe(isFinal) {
  if (_vpBusy) { if (isFinal) _vpPendingFinal = true; return; }
  if (!_vpAllPcm || _vpAllPcm.length === 0) {
    if (isFinal) { _setVoiceState('idle'); _setVoiceDownload(null); }
    return;
  }
  const rms = _vpRms(_vpAllPcm);
  console.log('[grom voice] RMS:', rms.toFixed(6));
  if (rms < _vpEnergyGate) {
    console.log('[grom voice] energy gate: skipping (RMS ' + rms.toFixed(6) + ' < ' + _vpEnergyGate + ')');
    if (isFinal) { _setVoiceState('idle'); _setVoiceDownload(null); }
    return;
  }
  const raw = _vpAllPcm.length > _VP_MAX_SAMPLES ? _vpAllPcm.slice(0, _VP_MAX_SAMPLES) : _vpAllPcm;
  const audio = new Float32Array(_VP_PAD + raw.length);
  audio.set(raw, _VP_PAD);
  const isMultilingual = !_vpModelId.endsWith('.en');

  _vpBusy = true;
  const worker = await _vpGetWorker();
  _vpAllPcm = null;
  worker.postMessage(
    { type: 'transcribe', modelId: _vpModelId, pcm: audio.buffer, isFinal, isMultilingual },
    [audio.buffer]
  );
}

function _vpAppendPcm(base64, isFinal) {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  if (bytes.length === 0) {
    // Empty final — all audio already sent as chunks; just transcribe what we have
    _vpTranscribe(true);
    return;
  }
  const chunk = new Float32Array(bytes.buffer);
  // Accumulate all chunks — only transcribe on final (push-to-talk)
  if (_vpAllPcm) {
    const merged = new Float32Array(_vpAllPcm.length + chunk.length);
    merged.set(_vpAllPcm);
    merged.set(chunk, _vpAllPcm.length);
    _vpAllPcm = merged;
  } else {
    _vpAllPcm = chunk;
  }
  console.log('[grom voice]', isFinal ? 'final' : 'chunk', 'PCM received, samples:', chunk.length, '(', (chunk.length / 16000).toFixed(2), 's), total:', _vpAllPcm.length);
  if (isFinal) _vpTranscribe(true);
}

let _ffmpegRemovePending = false;

function _vpSetFfmpegPresent(present) {
  const dl = document.getElementById('download-ffmpeg-btn');
  const rm = document.getElementById('remove-ffmpeg-btn');
  if (dl) dl.style.display = present ? 'none' : '';
  if (rm) {
    rm.style.display = present ? '' : 'none';
    if (present) { rm.disabled = false; rm.textContent = 'Remove ffmpeg'; }
  }
  if (!present && _ffmpegRemovePending) {
    _ffmpegRemovePending = false;
    const res = document.getElementById('clear-voice-result');
    if (res) { res.textContent = 'ffmpeg removed.'; setTimeout(() => { res.textContent = ''; }, 3000); }
  }
}

window.clearVoiceCache = async function() {
  if (_vpWorker) { _vpWorker.terminate(); _vpWorker = null; _vpWorkerPromise = null; }
  _vpClearDownloaded();
  _vpUpdateModelUI();
  try { const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k))); } catch {}
  _vpFlashResult('Cache cleared.', 3000);
};

window.downloadFfmpeg = function() {
  vscode.postMessage({ type: 'voiceDownloadFfmpeg' });
};

window.removeFfmpeg = function() {
  const rm = document.getElementById('remove-ffmpeg-btn');
  if (rm) { rm.disabled = true; rm.textContent = 'Removing…'; }
  _ffmpegRemovePending = true;
  vscode.postMessage({ type: 'removeFfmpeg' });
};

function _updateMicToggleBtn() {
  const btn = document.getElementById('mic-toggle-btn');
  if (!btn) return;
  btn.textContent = _voiceInputEnabled ? '● Mic on' : '○ Mic off';
  btn.classList.toggle('voice-mic-on', _voiceInputEnabled);
  btn.classList.toggle('voice-mic-off', !_voiceInputEnabled);
}

window.toggleMicVisibility = function() {
  vscode.postMessage({ type: _voiceInputEnabled ? 'disableVoiceInput' : 'enableVoiceInput' });
};

// Slider: 1–100 maps to 0.001–0.100 linearly
function _vpSliderToGate(v) { return Math.round(Number(v)) / 1000; }
function _vpGateToSlider(g) { return Math.round(g * 1000); }

function _vpSetSensitivity(gate, save) {
  _vpEnergyGate = gate;
  const slider = document.getElementById('voice-sensitivity-slider');
  const val = document.getElementById('voice-sensitivity-val');
  if (slider) slider.value = _vpGateToSlider(gate);
  if (val) val.textContent = gate.toFixed(3);
  if (save) vscode.postMessage({ type: 'setVoiceSensitivity', value: gate });
}

window.onVoiceSensitivityInput = function(v) {
  _vpSetSensitivity(_vpSliderToGate(v), false);
};

window.onVoiceSensitivityChange = function(v) {
  _vpSetSensitivity(_vpSliderToGate(v), true);
};

let _voiceToggleLock = false;
window.toggleVoiceInput = function() {
  console.log('[grom voice] toggleVoiceInput called, lock:', _voiceToggleLock, 'state:', _voiceState);
  if (_voiceToggleLock || _voiceState === 'transcribing') return;
  _voiceToggleLock = true;
  setTimeout(() => { _voiceToggleLock = false; }, 600);
  // Immediately reflect the state change so rapid clicks can't double-fire
  if (_voiceState === 'recording') _setVoiceState('transcribing');
  vscode.postMessage({ type: 'voiceToggle' });
};

window.addEventListener('message', e => {
  const m = e.data;
  switch (m.type) {
    case 'filesUsed': _lastAutoFiles = m.files || []; updateContextChips(_lastAutoFiles); break;
    case 'showMemory':
      _memoryOriginal = m.memory || '';
      document.getElementById('memory-editor').value = _memoryOriginal;
      document.getElementById('memory-overlay').style.display = 'flex';
      document.getElementById('memory-editor').focus();
      window.onMemoryInput();
      break;
    case 'memorySaved':
      _setMemoryDot(m.hasMemory);
      break;
    case 'showSystemPrompt':
      document.getElementById('sysprompt-editor').value = m.prompt || '';
      document.getElementById('sysprompt-overlay').style.display = 'flex';
      document.getElementById('sysprompt-editor').focus();
      break;
    case 'systemPromptSaved':
      _setSysPromptDot(m.hasSystemPrompt);
      document.getElementById('sysprompt-overlay').style.display = 'none';
      break;
    case 'welcome': {
      const welcomeDiv = renderMsg('ai', `To get started, pick a provider from the dropdown above:\n\n- **Ollama** or **LM Studio** — run them locally, then select a model from the dropdown\n- **Anthropic**, **OpenAI**, **Groq**, or **Mistral** — click the 🔒 icon next to the provider to add your API key\n- **Custom** — add any OpenAI-compatible endpoint via \`grom.customProviders\` in settings\n\nOnce connected, type a message and press **Enter**.\n\nType \`/help\` to see available commands, or \`@\` to attach files and context.\n\n**Two modes:** PLAN (gold) for thinking and designing, BUILD (blue) for writing code and shipping.\n\n**⚡ Tools** — visible in BUILD mode. Off by default for fast, clean chat. Turn it on when you want Grom to read and write files, run terminal commands, or use MCP tools. Each session remembers its own setting.\n\nClick the ⚙️ settings icon to customise Grom to your workflow.`);
      if (welcomeDiv) {
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:12px';
        if (m.iconUri) {
          const img = document.createElement('img');
          img.src = m.iconUri;
          img.style.cssText = 'width:40px;height:40px;flex-shrink:0';
          header.appendChild(img);
        }
        const title = document.createElement('strong');
        title.style.cssText = 'font-size:1.1em';
        title.textContent = 'Welcome to Grom!';
        header.appendChild(title);
        welcomeDiv.querySelector('.msg-body').prepend(header);
      }
      break;
    }
    case 'compacting':
    case 'compacted': {
      const notice = document.createElement('div');
      notice.className = 'compact-notice';
      notice.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 15 6 6m-6-6v4.8m0-4.8h4.8M9 9l-6-6m6 6V4.2M9 9H4.2"/></svg>conversation compacted`;
      chatContainer.appendChild(notice);
      chatContainer.scrollTop = chatContainer.scrollHeight;
      break;
    }
    case 'loadSessions':
      _currentSessionId = m.currentSessionId;
      robotAnimations = m.robotAnimations !== false;
      { _voiceInputEnabled = m.voiceInput !== false; const micBtn = document.getElementById('mic-btn'); if (micBtn) micBtn.style.display = _voiceInputEnabled ? '' : 'none'; _updateMicToggleBtn(); }
      currentMode = m.mode || 'plan';
      _setMemoryDot(m.hasMemory);
      _setSysPromptDot(m.hasSystemPrompt);
      _setAgentEnabled(m.agentEnabled ?? false);
      if (m.promptHistory?.length) { _inputHistory = m.promptHistory; _historyIdx = -1; }
      document.body.classList.remove('font-small', 'font-medium', 'font-large');
      document.body.classList.add('font-' + (m.fontSize || 'medium'));

      document.body.classList.remove('mode-plan', 'mode-build');
      document.body.classList.add('mode-' + currentMode);

      if (!robotAnimations) {
          const bubble = document.getElementById('thought-bubble'); if (bubble) bubble.classList.remove('active');
          clearInterval(thoughtInterval); thoughtInterval = null;
          document.querySelectorAll('.eye').forEach(e => e.classList.remove('closed'));
          document.querySelectorAll('.eye-lid').forEach(l => l.classList.remove('visible'));
          document.querySelectorAll('.eye-group').forEach(g => {
              g.style.transform = 'translate(0,0)';
              g.style.transition = 'none';
          });
      } else {
          document.querySelectorAll('.eye-group').forEach(g => g.style.transition = 'transform 0.1s ease-out');
      }

      modeToggle.classList.toggle('build', currentMode === 'build');
      document.getElementById('plan-btn').classList.toggle('active', currentMode === 'plan');
      document.getElementById('build-btn').classList.toggle('active', currentMode === 'build');

      _cancelActiveRename?.();
      document.getElementById('session-list').innerHTML = m.sessions.map(s => {
        const safeTitle = escapeHtml(s.title);
        return `<div class="session-item ${s.id === m.currentSessionId ? 'active' : ''}" data-session-id="${s.id}" title="Resume this conversation">
            <div class="session-title">${safeTitle}</div>
            <div class="session-actions">
              <div class="session-rename" data-rename-id="${s.id}" title="Rename"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></div>
              <div class="session-delete" data-delete-id="${s.id}" title="Delete"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></div>
            </div>
        </div>`;
      }).join('');
      wireSessionListClicks();

      const titleSpan = document.getElementById('current-title'), titleContainer = document.getElementById('current-title-container');
      if (titleSpan && titleContainer) {
          const current = m.sessions.find(s => s.id === m.currentSessionId);
          titleSpan.textContent = current ? current.title : 'Untitled';
          titleContainer.onclick = window.startEditingTitle;
      }

      const greeting = m.customGreeting || "Hey. I'm Grom. Ready when you are.";
      const defaultLogoContent = m.customLogo
          ? (m.customLogo.startsWith('http') || m.customLogo.startsWith('data:') ? `<img src="${m.customLogo}" alt="Grom">` : m.customLogo)
          : (window.GROM_IDLE_SVG || '');
      _gromLogoState = null;
      chatContainer.innerHTML = `<div class="empty-state" id="empty-state"><div class="empty-logo" id="main-logo" style="position:relative;">${defaultLogoContent}</div><div class="empty-text typing" id="main-greeting"></div></div>`;
      const greetEl = document.getElementById('main-greeting');
      let i = 0; greetEl.textContent = '';
      const typeInterval = setInterval(() => { greetEl.textContent += greeting[i++]; if (i >= greeting.length) { clearInterval(typeInterval); greetEl.classList.remove('typing'); } }, 80);
      updateGromLogo();

      if (m.presets) {
          const menu = document.getElementById('slash-menu');
          menu.innerHTML = '';
          m.presets.forEach(p => {
            const item = document.createElement('div'); item.className = 'menu-item';
            const preview = p.description || (p.text.startsWith('/') ? p.text : p.text.slice(0, 30) + (p.text.length > 30 ? '...' : ''));
            item.innerHTML = `<span class="menu-cmd">${escapeHtml(p.label)}</span><span style="opacity:0.5; font-size:10px;">${escapeHtml(preview)}</span>`;
            item.title = p.description || (p.text.length > 80 ? p.text.slice(0, 80) + '…' : p.text);
            item.dataset.insertText = p.text;
            item.dataset.cmd = p.label.toLowerCase();
            item.dataset.cmdAlt = (p.text.startsWith('/') ? p.text.slice(1) : '').toLowerCase();
            item.addEventListener('click', () => window.insertSlash(item.dataset.insertText));
            menu.appendChild(item);
          });
          const compact = document.createElement('div'); compact.className = 'menu-item';
          compact.innerHTML = `<span class="menu-cmd">Compact</span> <span style="opacity:0.5; font-size:10px;">Truncate history</span>`;
          compact.title = 'Truncate conversation history to free up context window space';
          compact.dataset.cmd = 'compact';
          compact.addEventListener('click', () => { window.compactSession(); window.toggleSlashMenu(false); });
          menu.appendChild(compact);
          const clearHist = document.createElement('div'); clearHist.className = 'menu-item';
          clearHist.innerHTML = `<span class="menu-cmd">Clear-history</span> <span style="opacity:0.5; font-size:10px;">Clear prompt history</span>`;
          clearHist.title = 'Clear your prompt input history (the ↑ / ↓ cycle)';
          clearHist.dataset.cmd = 'clear-history';
          clearHist.addEventListener('click', () => { _inputHistory = []; _historyIdx = -1; vscode.postMessage({ type: 'clearPromptHistory' }); window.toggleSlashMenu(false); renderMsg('ai', '*Prompt history cleared.*'); });
          menu.appendChild(clearHist);
      }

      renderTaskLog(m.taskLog || []);
      // Reset to sessions tab on session switch
      window.switchHistoryTab('sessions');

      if (m.history.length > 0) {
          document.getElementById('empty-state').style.display = 'none';
          document.getElementById('mini-grom')?.classList.add('visible');
          m.history.forEach(msg => {
            if (msg.role === 'system' && msg.content === '__compacted__') {
              const notice = document.createElement('div');
              notice.className = 'compact-notice';
              notice.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 15 6 6m-6-6v4.8m0-4.8h4.8M9 9l-6-6m6 6V4.2M9 9H4.2"/></svg>conversation compacted`;
              chatContainer.appendChild(notice);
            } else if (msg.role !== 'system') {
              renderMsg(msg.role === 'user' ? 'user' : 'ai', msg.content, msg.images);
            }
          });
      }
      break;
    case 'chunk': if (currentAiDiv) { currentAiText += m.text; const body = currentAiDiv.querySelector('.msg-body'); const dots = body.querySelector('.thinking-dots'); if (dots) { _stopElapsedTimer(); dots.remove(); } updateAiDisplay(body, currentAiText); if (!_userScrolledUp) chatContainer.scrollTop = chatContainer.scrollHeight; } break;
    case 'clearToolCallChunk': {
      if (currentAiDiv) {
        currentAiText = currentAiText.replace(m.raw, '').trim();
        const body = currentAiDiv.querySelector('.msg-body');
        if (currentAiText) { updateAiDisplay(body, currentAiText); } else { body.innerHTML = ''; }
      }
      break;
    }
    case 'toolCall': {
      if (currentAiDiv) {
        const body = currentAiDiv.querySelector('.msg-body');
        const dots = body.querySelector('.thinking-dots'); if (dots) { _stopElapsedTimer(); dots.remove(); }
        // Remove any previous tool-call badge for this turn
        body.querySelectorAll('.tool-call-badge').forEach(el => el.remove());
        const badge = document.createElement('div');
        badge.className = 'tool-call-badge';
        badge.innerHTML = `<span class="tool-call-spinner"></span><span>Using tool <code>${m.tool}</code>…</span>`;
        body.appendChild(badge);
        if (!_userScrolledUp) chatContainer.scrollTop = chatContainer.scrollHeight;
      }
      break;
    }
    case 'agentWritesDone': {
      if (currentAiDiv && m.files?.length) {
        const body = currentAiDiv.querySelector('.msg-body');
        const existing = body.querySelector('.agent-revert-btn');
        if (existing) existing.remove();
        const btn = document.createElement('button');
        btn.className = 'agent-revert-btn';
        btn.textContent = `↩ Undo agent writes (${m.files.length} file${m.files.length > 1 ? 's' : ''})`;
        btn.onclick = () => vscode.postMessage({ type: 'revertAgentChanges' });
        body.appendChild(btn);
        if (!_userScrolledUp) chatContainer.scrollTop = chatContainer.scrollHeight;
      }
      break;
    }
    case 'status': if (m.text === 'Ready') {
      // Ignore Ready from a previous aborted request if a new one is already in flight
      if (currentAiDiv && currentAiDiv._requestId && currentAiDiv._requestId !== _requestId) break;
      sendBtn.style.display = 'flex'; stopBtn.style.display = 'none'; document.body.classList.remove('grom-thinking'); updateGromLogo();
      vscode.postMessage({ type: 'updateHistory', text: currentAiText });
      if (currentAiDiv) {
        currentAiDiv.querySelector('.tool-call-badge')?.remove();
        const dots = currentAiDiv.querySelector('.thinking-dots');
        if (dots) { _stopElapsedTimer(); dots.remove(); if (!currentAiText.trim()) currentAiDiv.querySelector('.msg-body').textContent = ''; }
      }
    } break;
    case 'voiceState': _setVoiceState(m.state); break;
    case 'voiceDownload': _setVoiceDownload(m.text); break;
    case 'voiceInputChanged': {
      _voiceInputEnabled = m.enabled !== false;
      const micBtn = document.getElementById('mic-btn');
      if (micBtn) micBtn.style.display = _voiceInputEnabled ? '' : 'none';
      _updateMicToggleBtn();
      break;
    }
    case 'voiceModelConfig': {
      _vpModelId = m.model || 'tiny.en'; _vpSelectedId = _vpModelId; _vpUpdateModelUI();
      if (typeof m.sensitivity === 'number') _vpSetSensitivity(m.sensitivity, false);
      break;
    }
    case 'voiceAudioStart': {
      _vpAllPcm = null; _vpBusy = false; _vpPendingFinal = false;
      const _existingPrompt = document.getElementById('prompt');
      _vpTranscribedText = _existingPrompt ? _existingPrompt.value.trim() : '';
      // Warm up the worker and pre-load the model while the user is still speaking
      _vpGetWorker().then(w => w.postMessage({ type: 'load', modelId: _vpModelId })).catch(() => {});
      break;
    }
    case 'voiceAudio': _vpAppendPcm(m.pcm, m.isFinal); break;
    case 'voiceClearCache': void window.clearVoiceCache(); break;
    case 'voiceFfmpegReady':
      _vpSetFfmpegPresent(true);
      _vpMaybeWarmUp();
      break;
    case 'voiceFfmpegStatus':
      _vpSetFfmpegPresent(m.present);
      if (m.present) _vpMaybeWarmUp();
      break;
    case 'voiceNoFfmpeg': {
      _vpSetFfmpegPresent(false);
      const nudge = document.createElement('div'); nudge.className = 'msg ai nudge-msg';
      if (window.GROM_LOGOS?.default) {
        const avatar = document.createElement('img'); avatar.src = window.GROM_LOGOS.default;
        avatar.className = 'nudge-avatar'; nudge.appendChild(avatar);
      }
      const body = document.createElement('div'); body.className = 'msg-body nudge-body';
      body.innerHTML = `Voice input requires <strong>ffmpeg</strong> for audio capture — it wasn't found on this system. Download it automatically (~80 MB, one-time), or install it yourself via <code>winget install ffmpeg</code> / <code>brew install ffmpeg</code> and it will be detected on next use.`;
      const btns = document.createElement('div'); btns.className = 'voice-setup-btns';
      const dlBtn = document.createElement('button'); dlBtn.className = 'nudge-btn';
      dlBtn.textContent = 'Download ffmpeg';
      dlBtn.onclick = () => { nudge.remove(); vscode.postMessage({ type: 'voiceDownloadFfmpeg' }); };
      const dismissBtn = document.createElement('button'); dismissBtn.className = 'nudge-btn';
      dismissBtn.style.cssText = 'background:transparent;border:1px solid var(--border);color:var(--text);';
      dismissBtn.textContent = 'Dismiss';
      dismissBtn.onclick = () => nudge.remove();
      const hideRow = document.createElement('div'); hideRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
      const hideBtn = document.createElement('button'); hideBtn.className = 'nudge-btn';
      hideBtn.style.cssText = 'background:transparent;border:1px solid var(--border);color:var(--text);';
      hideBtn.textContent = 'Hide mic button';
      hideBtn.onclick = () => { nudge.remove(); vscode.postMessage({ type: 'disableVoiceInput' }); };
      const hideInfo = document.createElement('span');
      hideInfo.className = 'info-badge';
      hideInfo.title = 'You can re-enable the mic button anytime in Settings → Voice Input';
      hideInfo.textContent = 'i';
      const hideBeta = document.createElement('span');
      hideBeta.className = 'beta-tag';
      hideBeta.textContent = 'beta';
      hideRow.appendChild(hideBtn); hideRow.appendChild(hideInfo); hideRow.appendChild(hideBeta);
      btns.appendChild(dlBtn); btns.appendChild(dismissBtn); btns.appendChild(hideRow);
      body.appendChild(btns); nudge.appendChild(body);
      chatContainer.appendChild(nudge);
      if (!_userScrolledUp) chatContainer.scrollTop = chatContainer.scrollHeight;
      break;
    }
    case 'voiceModelRemoved':
      _vpFlashResult('Cache cleared.', 3000);
      break;
    case 'voiceTranscript':
      if (m.text) _vpInjectToPrompt(m.text.trim());
      break;
    case 'voiceError': {
      console.error('[voice] error from host:', m.message);
      _vpFlashResult(m.message, 5000);
      _setVoiceDownload('⚠ ' + m.message);
      setTimeout(() => _setVoiceDownload(null), 5000);
      break;
    }
    case 'idleHint': {
      const bubble = document.getElementById('thought-bubble');
      if (bubble && bubble.classList.contains('active')) bubble.textContent = m.text;
      break;
    }
    case 'resendText': {
      const allMsgs = Array.from(chatContainer.querySelectorAll('.msg.user, .msg.ai, .nudge-msg'));
      let lastUserIdx = -1;
      for (let i = allMsgs.length - 1; i >= 0; i--) { if (allMsgs[i].classList.contains('user')) { lastUserIdx = i; break; } }
      if (lastUserIdx !== -1) { for (let i = lastUserIdx; i < allMsgs.length; i++) allMsgs[i].remove(); }
      const remainingUsers = chatContainer.querySelectorAll('.msg.user');
      if (remainingUsers.length) { const btn = remainingUsers[remainingUsers.length - 1].querySelector('.resend-btn'); if (btn) btn.style.display = ''; }
      prompt.value = m.text; prompt.style.height = 'auto'; prompt.style.height = prompt.scrollHeight + 'px';
      sendBtn.onclick();
      break;
    }
    case 'toolsOffNudge': {
      const nudge = document.createElement('div'); nudge.className = 'msg ai nudge-msg';
      if (window.GROM_LOGOS?.default) {
        const avatar = document.createElement('img'); avatar.src = window.GROM_LOGOS.default;
        avatar.className = 'nudge-avatar'; nudge.appendChild(avatar);
      }
      const body = document.createElement('div'); body.className = 'msg-body nudge-body';
      body.innerHTML = `Looks like ⚡ Tools is off — <strong>${m.model}</strong> tried to call a tool but couldn't. Turn on Tools and resend?`;
      const btn = document.createElement('button'); btn.className = 'nudge-btn';
      btn.textContent = 'Enable Tools and Resend';
      btn.onclick = () => {
        _setAgentEnabled(true);
        vscode.postMessage({ type: 'toggleAgent', enabled: true });
        nudge.remove();
        vscode.postMessage({ type: 'resend' });
      };
      body.appendChild(btn); nudge.appendChild(body);
      chatContainer.appendChild(nudge);
      if (!_userScrolledUp) chatContainer.scrollTop = chatContainer.scrollHeight;
      break;
    }
    case 'gromHint': {
      if (m.hint === 'context') {
        const nudge = document.createElement('div'); nudge.className = 'msg ai nudge-msg';
        if (window.GROM_LOGOS?.default) {
          const avatar = document.createElement('img'); avatar.src = window.GROM_LOGOS.default;
          avatar.className = 'nudge-avatar'; nudge.appendChild(avatar);
        }
        const body = document.createElement('div'); body.className = 'msg-body nudge-body';
        body.innerHTML = `Context is <strong>${m.percent}% full</strong>. Consider running <code>/compact</code> to trim history and keep responses accurate.`;
        const btn = document.createElement('button'); btn.className = 'nudge-btn';
        btn.textContent = 'Run /compact';
        btn.onclick = () => { prompt.value = '/compact'; sendBtn.onclick(); nudge.remove(); };
        body.appendChild(btn); nudge.appendChild(body);
        chatContainer.appendChild(nudge);
        if (!_userScrolledUp) chatContainer.scrollTop = chatContainer.scrollHeight;
      } else if (m.hint === 'docs') {
        const nudge = document.createElement('div'); nudge.className = 'msg ai nudge-msg';
        if (window.GROM_LOGOS?.default) {
          const avatar = document.createElement('img'); avatar.src = window.GROM_LOGOS.default;
          avatar.className = 'nudge-avatar'; nudge.appendChild(avatar);
        }
        const body = document.createElement('div'); body.className = 'msg-body nudge-body';
        body.innerHTML = `No documentation sources are configured. Add URLs to <code>grom.docSources</code> so <code>@docs</code> has something to search.`;
        const btn = document.createElement('button'); btn.className = 'nudge-btn';
        btn.textContent = 'Open Settings';
        btn.onclick = () => { vscode.postMessage({ type: 'openSettings', query: 'grom.docSources' }); nudge.remove(); };
        body.appendChild(btn); nudge.appendChild(body);
        chatContainer.appendChild(nudge);
        if (!_userScrolledUp) chatContainer.scrollTop = chatContainer.scrollHeight;
      }
      break;
    }
    case 'statusUpdate':
      _currentCaps = m.caps || null;
      document.getElementById('conn-status').textContent = m.status;
      const dot = document.getElementById('status-dot'); dot.className = 'status-dot';
      if (m.status === 'Connected') {
        dot.classList.add('online');
        document.body.classList.remove('grom-disconnected', 'grom-error');
        clearTimeout(_retryTimer);
      } else if (m.status.includes('...')) {
      } else if (m.status === 'Disconnected') {
        dot.classList.add('offline');
        document.body.classList.remove('grom-error');
        document.body.classList.add('grom-disconnected');
        scheduleRetry();
      } else {
        dot.classList.add('offline');
        document.body.classList.remove('grom-disconnected');
        document.body.classList.add('grom-error');
        scheduleRetry();
      }
      updateGromLogo();
      const ps = document.getElementById('provider-select');
      const providerOpts = [
        { value: 'ollama',    label: 'Ollama',    tooltip: 'Ollama — run local models on your machine (ollama.ai)' },
        { value: 'lmstudio', label: 'LM Studio',  tooltip: 'LM Studio — local models via LM Studio (lmstudio.ai)' },
        { value: 'opencode', label: 'Open Code',  tooltip: 'Open Code — VS Code-native AI coding agent' },
        { value: 'openai',   label: 'OpenAI',     tooltip: 'OpenAI — GPT-4o and o-series models (API key required)' },
        { value: 'anthropic',label: 'Anthropic',  tooltip: 'Anthropic — Claude models (API key required)' },
        { value: 'groq',     label: 'Groq',       tooltip: 'Groq — fast inference cloud API (API key required)' },
        { value: 'mistral',  label: 'Mistral',    tooltip: 'Mistral — open-weight model API (API key required)' },
        { value: 'gemini',   label: 'Gemini',     tooltip: 'Gemini — Google models (API key required)' },
        ...(m.customProviders || []).map((cp, i) => ({ value: `custom:${i}`, label: cp.name, tooltip: cp.url ? `${cp.name} — ${cp.url}` : cp.name }))
      ];
      ps.setOptions(providerOpts);
      ps._customProviders = m.customProviders || [];
      ps.onchange = (ev) => {
        const val = ev.target.value;
        if (val.startsWith('custom:')) {
          const idx = parseInt(val.split(':')[1]);
          const cp = ps._customProviders[idx];
          vscode.postMessage({ type: 'changeProvider', providerId: 'custom', url: cp.url, useOllamaFormat: cp.useOllamaFormat ?? false, providerName: cp.name });
        } else {
          vscode.postMessage({ type: 'changeProvider', providerId: val });
        }
        _updateKeyBtn(val, ps._customProviders);
      };
      if (m.useOllama) ps.value = 'ollama';
      else if (m.url?.includes('1234')) ps.value = 'lmstudio';
      else if (m.url?.includes('opencode')) ps.value = 'opencode';
      else if (m.url?.includes('openai.com')) ps.value = 'openai';
      else if (m.url?.includes('anthropic.com')) ps.value = 'anthropic';
      else if (m.url?.includes('groq.com')) ps.value = 'groq';
      else if (m.url?.includes('mistral.ai')) ps.value = 'mistral';
      else if (m.url?.includes('googleapis.com')) ps.value = 'gemini';
      else if (m.customProviders?.length) {
        const idx = m.customProviders.findIndex(cp => m.url?.startsWith(cp.url));
        if (idx >= 0) ps.value = `custom:${idx}`;
      }
      _updateKeyBtn(ps.value, ps._customProviders);
      const capsBar = document.getElementById('model-caps');
      if (capsBar) {
          capsBar.innerHTML = '';
          if (m.caps?.reasoning) capsBar.innerHTML += `<div class="cap-icon cap-reasoning" title="Reasoning model — supports extended thinking"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#c084fc" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2.54z"></path><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2.54z"></path></svg></div>`;
          if (m.caps?.vision) capsBar.innerHTML += `<div class="cap-icon cap-vision" title="Vision model — can process images"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#E8A838" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg></div>`;
          if (m.caps?.tools) capsBar.innerHTML += `<div class="cap-icon cap-tools" title="Tool use — can call functions"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#3B8FCC" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg></div>`;
      }
      if (m.model) { const ms = document.getElementById('model-select'); ms.setOptions((m.models || []).map(mdl => ({ value: mdl, label: mdl }))); ms.value = m.model; ms.onchange = (ev) => vscode.postMessage({ type: 'changeModel', model: ev.target.value }); }
      updateCapIcons();
      break;
    case 'capsUpdate': {
      _currentCaps = m.caps || null;
      const capsBar = document.getElementById('model-caps');
      if (capsBar) {
        capsBar.innerHTML = '';
        if (m.caps?.reasoning) capsBar.innerHTML += `<div class="cap-icon cap-reasoning" title="Reasoning model — supports extended thinking"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#c084fc" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2.54z"></path><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2.54z"></path></svg></div>`;
        if (m.caps?.vision) capsBar.innerHTML += `<div class="cap-icon cap-vision" title="Vision model — can process images"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#E8A838" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg></div>`;
        if (m.caps?.tools) capsBar.innerHTML += `<div class="cap-icon cap-tools" title="Tool use — can call functions"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#3B8FCC" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg></div>`;
      }
      updateCapIcons();
      break;
    }
    case 'usageUpdate': {
      const circle = document.getElementById('usage-fill'), circ = 56.5;
      circle.style.strokeDashoffset = circ - (m.contextPercent / 100) * circ;
      const total = (m.inputTokens || 0) + (m.outputTokens || 0);
      const totalCost = (m.inputCost || 0) + (m.outputCost || 0);
      const costStr = totalCost > 0 ? ` • $${totalCost.toFixed(4)}` : '';
      document.getElementById('usage-display').title = `${total.toLocaleString()} / ${(m.contextWindow || 0).toLocaleString()} tokens (${m.contextPercent || 0}%)${costStr}`;
      break;
    }
    case 'setTheme':
        const themeClass = 'theme-' + m.theme.toLowerCase().replace(' ', '-');
        Array.from(document.body.classList).forEach(c => { if (c.startsWith('theme-')) document.body.classList.remove(c); });
        document.body.classList.add(themeClass);
        break;
    case 'testConnectionResult': {
      const btn = document.getElementById('test-conn-btn');
      const result = document.getElementById('test-conn-result');
      if (btn) { btn.disabled = false; btn.textContent = 'Test Connection'; }
      if (result) {
        result.textContent = (m.ok ? '✓ ' : '✕ ') + m.message;
        result.style.color = m.ok ? 'var(--vscode-testing-iconPassed,#73c991)' : 'var(--vscode-errorForeground,#f48771)';
      }
      break;
    }
    case 'mcpStatus': {
      const list = document.getElementById('mcp-tool-list');
      const count = document.getElementById('mcp-tool-count');
      if (!list) break;
      if (!m.tools || m.tools.length === 0) {
        list.textContent = 'No MCP tools configured. Add servers via grom.mcpServers in settings.';
        if (count) count.textContent = '';
      } else {
        if (count) count.textContent = `(${m.tools.length})`;
        list.innerHTML = m.tools.map(t =>
          `<div style="padding:2px 0;"><code style="opacity:0.9;">${t.name}</code> — <span style="opacity:0.6;">${t.description || ''}</span></div>`
        ).join('');
      }
      updateCapIcons();
      break;
    }
    case 'taskLogEntry': appendTaskLogEntry(m.entry); break;
    case 'sessionListUpdate': {
      _cancelActiveRename?.();
      const list = document.getElementById('session-list');
      if (list) {
        list.innerHTML = m.sessions.map(s => {
          const safeTitle = escapeHtml(s.title);
          return `<div class="session-item ${s.id === m.currentSessionId ? 'active' : ''}" data-session-id="${s.id}">
            <div class="session-title">${safeTitle}</div>
            <div class="session-actions">
              <div class="session-rename" data-rename-id="${s.id}" title="Rename"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></div>
              <div class="session-delete" data-delete-id="${s.id}" title="Delete"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></div>
            </div>
          </div>`;
        }).join('');
      }
      const headerTitle = document.getElementById('current-title');
      if (headerTitle) {
        const current = m.sessions.find(s => s.id === m.currentSessionId);
        if (current) headerTitle.textContent = current.title;
      }
      wireSessionListClicks();
      break;
    }
    case 'sessionTitleUpdate': {
      const item = document.querySelector(`[data-session-id="${m.sessionId}"] .session-title`);
      if (item) item.textContent = m.title;
      // Also update the header title if this is the active session
      const headerTitle = document.getElementById('current-title');
      if (headerTitle) headerTitle.textContent = m.title;
      break;
    }
    case 'toolApproval': renderApprovalCard(m); break;
    case 'toolDenied': {
      if (currentAiDiv) {
        const body = currentAiDiv.querySelector('.msg-body');
        body.querySelectorAll('.tool-call-badge').forEach(el => el.remove());
        const badge = document.createElement('div');
        badge.className = 'tool-call-badge tool-call-denied';
        badge.innerHTML = `<span>✕ Denied <code>${m.tool}</code></span>`;
        body.appendChild(badge);
      }
      break;
    }
    case 'fileCreated': {
      // Find any save button that was waiting and confirm it
      document.querySelectorAll('.code-btn-accept').forEach(btn => {
        if (btn.title === `Save as ${m.path}`) { btn.textContent = '✓ Saved'; btn.disabled = true; }
      });
      break;
    }
    case 'triggerAction': prompt.value = m.text; sendBtn.onclick(); break;
    case 'indexingProgress': {
      const indicator = document.getElementById('indexing-indicator');
      const text = document.getElementById('indexing-text');
      if (indicator) {
        if (m.progress < 100) {
          indicator.style.display = 'flex';
          if (text) text.textContent = `Indexing (${m.progress}%)...`;
        } else {
          indicator.style.display = 'none';
        }
      }
      break;
    }
    case 'fileList': _allFiles = m.files || []; showFilePicker(''); break;
  }
});

let _allFiles = [];
const filePicker = document.createElement('div');
filePicker.id = 'file-picker'; filePicker.className = 'floating-menu'; filePicker.style.display = 'none';
document.getElementById('input-container').appendChild(filePicker);

const CONTEXT_PROVIDERS = [
  { name: 'selection', desc: 'Currently selected text in the editor' },
  { name: 'problems', desc: 'VS Code errors & warnings' },
  { name: 'git', desc: 'Current git diff' },
  { name: 'terminal', desc: 'Recent terminal output' },
  { name: 'docs', desc: 'Search indexed documentation (@docs:name for specific source)' },
  { name: 'url:', desc: 'Fetch a URL  e.g. @url:https://...' },
];

function showFilePicker(query) {
  const atMatch = prompt.value.match(/@(\S*)$/);
  if (!atMatch) { filePicker.style.display = 'none'; return; }
  const q = atMatch[1].toLowerCase();
  const specials = CONTEXT_PROVIDERS.filter(p => p.name.startsWith(q) || q === '');
  const filtered = _allFiles.filter(f => !q || f.name.toLowerCase().includes(q));
  const openMatches = filtered.filter(f => f.group === 'open').slice(0, 4);
  const wsMatches = filtered.filter(f => f.group !== 'open').slice(0, 5);
  if (!specials.length && !openMatches.length && !wsMatches.length) { filePicker.style.display = 'none'; return; }
  const specialHtml = specials.map(p =>
    `<div class="menu-item" onclick="window.pickFile('@${p.name}')"><span class="menu-cmd" style="color:var(--accent);">@${p.name}</span><span style="opacity:0.5;font-size:10px;margin-left:6px;">${p.desc}</span></div>`
  ).join('');
  const openHtml = openMatches.map(f =>
    `<div class="menu-item" onclick="window.pickFile('${_escHtml(f.name)}')"><span class="menu-cmd">${_escHtml(f.name)}</span><span class="file-open-badge">open</span></div>`
  ).join('');
  const wsHtml = wsMatches.map(f =>
    `<div class="menu-item" onclick="window.pickFile('${_escHtml(f.name)}')"><span class="menu-cmd">${_escHtml(f.name)}</span></div>`
  ).join('');
  filePicker.innerHTML = specialHtml + openHtml + wsHtml;
  filePicker.style.display = 'flex';
}

window.pickFile = (name) => {
  // Special providers pass the full '@name' string; files pass just the name
  const insertion = name.startsWith('@') ? name + ' ' : `@${name} `;
  prompt.value = prompt.value.replace(/@\S*$/, insertion);
  filePicker.style.display = 'none';
  prompt.focus();
};

prompt.addEventListener('input', () => {
  const atMatch = prompt.value.match(/@(\S*)$/);
  if (atMatch) {
    if (_allFiles.length === 0) vscode.postMessage({ type: 'getFiles' });
    else showFilePicker(atMatch[1]);
  } else { filePicker.style.display = 'none'; }
});

document.addEventListener('mousedown', (e) => {
  if (!filePicker.contains(e.target)) filePicker.style.display = 'none';
});
let _retryTimer = null;
function scheduleRetry() {
    clearTimeout(_retryTimer);
    _retryTimer = setTimeout(() => vscode.postMessage({ type: 'retryConnection' }), 5000);
}
// Periodic idle check — skip during generation so single-threaded servers (LM Studio) aren't polled while busy
setInterval(() => { if (!document.body.classList.contains('grom-thinking')) vscode.postMessage({ type: 'retryConnection' }); }, 60000);

document.addEventListener('click', e => {
  const link = e.target.closest('[data-path]');
  if (link && !e.target.closest('.session-item') && !e.target.closest('.grom-select')) {
    e.preventDefault();
    vscode.postMessage({ type: 'openFile', path: link.dataset.path });
  }
});

vscode.postMessage({ type: 'ready' }); resetIdle(true); setTimeout(() => prompt.focus(), 100);
