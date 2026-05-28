import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

const root = process.cwd();
const html = fs.readFileSync(path.join(root, 'media', 'webview.html'), 'utf8');
const js   = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
const css  = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');
const provider = fs.readFileSync(path.join(root, 'src', 'provider.ts'), 'utf8');

// ── webview.html ──────────────────────────────────────────────────────────────

describe('popout — webview.html', () => {
  it('#popout-btn exists in header-actions', () => {
    expect(html).to.include('id="popout-btn"',
      'Pop-out button missing from webview.html');
  });

  it('#popout-btn posts { type: "popout" } on click', () => {
    expect(html).to.include("type:'popout'",
      '#popout-btn does not post popout message');
  });

  it('#popout-btn tooltip says Float not Pop out', () => {
    expect(html).to.include('Float Grom',
      '#popout-btn tooltip should say "Float Grom"');
  });

  it('#popout-banner exists', () => {
    expect(html).to.include('id="popout-banner"',
      'Popout banner missing from webview.html');
  });

  it('#popout-banner posts closePopout on button click', () => {
    expect(html).to.include("type:'closePopout'",
      'Banner close button does not post closePopout');
  });

  it('#popout-banner button says "Close floating" not "Close popout"', () => {
    expect(html).to.include('Close floating',
      'Banner button should say "Close floating"');
    expect(html).to.not.include('Close popout',
      'Banner button should not say "Close popout"');
  });

  it('#popout-banner is hidden by default (display:none)', () => {
    const m = html.match(/<div[^>]*id="popout-banner"[^>]*>/);
    expect(m).to.not.equal(null, '#popout-banner element not found');
    expect(m![0]).to.include('display:none',
      '#popout-banner should be hidden by default');
  });

  it('#popout-pill exists in header', () => {
    expect(html).to.include('id="popout-pill"',
      'Floating indicator pill missing from webview.html');
  });

  it('#popout-pill is hidden by default', () => {
    const m = html.match(/<span[^>]*id="popout-pill"[^>]*>/);
    expect(m).to.not.equal(null, '#popout-pill element not found');
    expect(m![0]).to.include('display:none',
      '#popout-pill should be hidden by default');
  });

  it('#popout-pill says "floating"', () => {
    expect(html).to.include('>floating<',
      '#popout-pill should contain the text "floating"');
  });

  it('GROM_FLOAT_PLAN_SVG placeholder exists', () => {
    expect(html).to.include('GROM_FLOAT_PLAN_SVG',
      'Float plan SVG window variable missing');
  });

  it('GROM_FLOAT_BUILD_SVG placeholder exists', () => {
    expect(html).to.include('GROM_FLOAT_BUILD_SVG',
      'Float build SVG window variable missing');
  });

  it('GROM_MIC_PLAN_SVG placeholder exists', () => {
    expect(html).to.include('GROM_MIC_PLAN_SVG',
      'Mic plan SVG window variable missing');
  });

  it('GROM_MIC_BUILD_SVG placeholder exists', () => {
    expect(html).to.include('GROM_MIC_BUILD_SVG',
      'Mic build SVG window variable missing');
  });

  it('GROM_HINT_MIC_SVG placeholder exists', () => {
    expect(html).to.include('GROM_HINT_MIC_SVG',
      'Hint mic SVG window variable missing');
  });

  it('GROM_LOGOS includes micPlan and micBuild URIs', () => {
    expect(html).to.include('micPlan',
      'GROM_LOGOS missing micPlan entry');
    expect(html).to.include('micBuild',
      'GROM_LOGOS missing micBuild entry');
  });
});

// ── main.js — message handlers ────────────────────────────────────────────────

describe('popout — main.js message handling', () => {
  it("handles 'popoutOpened' case", () => {
    expect(js).to.include("case 'popoutOpened'",
      "popoutOpened case missing from message handler");
  });

  it("handles 'popoutClosed' case", () => {
    expect(js).to.include("case 'popoutClosed'",
      "popoutClosed case missing from message handler");
  });

  it("handles 'popoutActive' case (popout panel self-init)", () => {
    expect(js).to.include("case 'popoutActive'",
      "popoutActive case missing from message handler");
  });

  it('popoutOpened disables the prompt textarea', () => {
    expect(js).to.include("prompt.disabled = true",
      'popoutOpened must disable the prompt textarea');
  });

  it('popoutOpened adds popout-active class to input-container', () => {
    expect(js).to.include("classList.add('popout-active')",
      'popoutOpened must add popout-active class to input-container');
  });

  it('popoutOpened shows the banner', () => {
    expect(js).to.include("banner.style.display = 'flex'",
      'popoutOpened must show the banner');
  });

  it('popoutOpened hides the popout button', () => {
    expect(js).to.include("popoutBtn.style.display = 'none'",
      'popoutOpened must hide the popout button');
  });

  it('popoutClosed re-enables the prompt textarea', () => {
    expect(js).to.include("prompt.disabled = false",
      'popoutClosed must re-enable the prompt textarea');
  });

  it('popoutClosed removes popout-active class from input-container', () => {
    expect(js).to.include("classList.remove('popout-active')",
      'popoutClosed must remove popout-active class from input-container');
  });

  it('popoutClosed hides the banner', () => {
    expect(js).to.include("banner.style.display = 'none'",
      'popoutClosed must hide the banner');
  });

  it('popoutClosed restores the popout button', () => {
    expect(js).to.include("popoutBtn.style.display = ''",
      'popoutClosed must restore the popout button visibility');
  });

  it('popoutActive sets _isPopout = true', () => {
    expect(js).to.include('_isPopout = true',
      'popoutActive must set _isPopout to true');
  });

  it('popoutActive shows the floating pill', () => {
    expect(js).to.include("pill.style.display = 'inline'",
      'popoutActive must show the floating pill');
  });

  it('_isPopout skips typewriter animation on greeting', () => {
    expect(js).to.include('_isPopout',
      'loadSessions must check _isPopout to skip typewriter');
  });

  it('popoutActive adds grom-popout class to body', () => {
    expect(js).to.include("classList.add('grom-popout')",
      'popoutActive must add grom-popout class to body for larger logo sizing');
  });

  it('updateGromLogo uses float plan SVG when _isPopout and default state', () => {
    expect(js).to.match(/_isPopout.*GROM_FLOAT_PLAN_SVG|GROM_FLOAT_PLAN_SVG.*_isPopout/,
      'updateGromLogo must use GROM_FLOAT_PLAN_SVG when _isPopout is true');
  });

  it('updateGromLogo uses float build SVG when _isPopout and building state', () => {
    expect(js).to.match(/_isPopout.*GROM_FLOAT_BUILD_SVG|GROM_FLOAT_BUILD_SVG.*_isPopout/,
      'updateGromLogo must use GROM_FLOAT_BUILD_SVG when _isPopout is true');
  });

  it('loadSessions greeting uses float plan SVG when _isPopout', () => {
    expect(js).to.include('GROM_FLOAT_PLAN_SVG',
      'loadSessions must use GROM_FLOAT_PLAN_SVG for greeting logo when _isPopout');
  });
});

// ── main.js — mic logo swap ───────────────────────────────────────────────────

describe('popout — main.js mic logo swap', () => {
  it('_setVoiceState swaps main logo to mic variant on recording', () => {
    expect(js).to.include('GROM_MIC_BUILD_SVG',
      '_setVoiceState must reference GROM_MIC_BUILD_SVG');
    expect(js).to.include('GROM_MIC_PLAN_SVG',
      '_setVoiceState must reference GROM_MIC_PLAN_SVG');
  });

  it('_setVoiceState swaps mini-grom src to mic variant on recording', () => {
    expect(js).to.include('micBuild',
      '_setVoiceState must set mini-grom src to micBuild');
    expect(js).to.include('micPlan',
      '_setVoiceState must set mini-grom src to micPlan');
  });

  it('_setVoiceState uses __mic__ sentinel to gate logo restore', () => {
    expect(js).to.include("'__mic__'",
      '_setVoiceState must use __mic__ sentinel to prevent premature logo restore');
  });

  it('voiceNoFfmpeg nudge uses GROM_HINT_MIC_SVG avatar', () => {
    expect(js).to.include('GROM_HINT_MIC_SVG',
      'voiceNoFfmpeg nudge must use GROM_HINT_MIC_SVG as avatar');
  });
});

// ── styles.css ────────────────────────────────────────────────────────────────

describe('popout — CSS', () => {
  it('#popout-banner has CSS', () => {
    expect(css).to.include('#popout-banner',
      '#popout-banner CSS missing');
  });

  it('#input-container.popout-active has CSS', () => {
    expect(css).to.include('#input-container.popout-active',
      '#input-container.popout-active CSS missing');
  });

  it('#input-container.popout-active uses pointer-events: none', () => {
    expect(css).to.match(/#input-container\.popout-active[^}]*pointer-events\s*:\s*none/,
      '#input-container.popout-active must use pointer-events: none to block interaction');
  });

  it('#popout-pill has CSS', () => {
    expect(css).to.include('#popout-pill',
      '#popout-pill CSS missing');
  });

  it('body.grom-popout .empty-logo has larger size than default', () => {
    expect(css).to.include('body.grom-popout .empty-logo',
      'body.grom-popout .empty-logo size override missing');
  });

  it('body.grom-popout .empty-logo size is larger than default 80px', () => {
    const m = css.match(/body\.grom-popout \.empty-logo\s*\{[^}]*width\s*:\s*(\d+)px/);
    expect(m).to.not.equal(null, 'body.grom-popout .empty-logo width not found');
    expect(parseInt(m![1])).to.be.greaterThan(80,
      'Popout logo must be larger than the default 80px');
  });

  it('body.grom-popout .empty-logo svg has size override', () => {
    expect(css).to.include('body.grom-popout .empty-logo svg',
      'body.grom-popout .empty-logo svg size override missing');
  });
});

// ── provider.ts — voice routing ───────────────────────────────────────────────

describe('popout — provider.ts voice routing', () => {
  it('_voiceReply field is declared', () => {
    expect(provider).to.include('_voiceReply',
      '_voiceReply field missing from provider');
  });

  it('voiceToggle sets _voiceReply to reply', () => {
    expect(provider).to.include('this._voiceReply = reply',
      'voiceToggle must set _voiceReply to the sending webview');
  });

  it('voiceAudio is routed to _voiceReply not broadcast', () => {
    expect(provider).to.include("msg.type === 'voiceAudio'",
      'VoiceManager callback must route voiceAudio to _voiceReply');
    expect(provider).to.include('this._voiceReply?.postMessage',
      'voiceAudio must be posted only to _voiceReply');
  });

  it('voiceAudio routing has try-catch for disposed webview', () => {
    expect(provider).to.include("try { this._voiceReply?.postMessage(msg); } catch",
      'voiceAudio postMessage must be wrapped in try-catch');
  });

  it('cleanupPopout sends popoutClosed to sidebar', () => {
    expect(provider).to.include("type: 'popoutClosed'",
      'cleanupPopout must send popoutClosed to sidebar');
  });

  it('cleanupPopout sends voiceState idle to sidebar', () => {
    expect(provider).to.include("type: 'voiceState', state: 'idle'",
      'cleanupPopout must reset voice state to idle on popout close');
  });

  it('cleanupPopout wraps panel.webview access in try-catch', () => {
    expect(provider).to.include('try { if (this._voiceReply === panel.webview)',
      'panel.webview access in cleanupPopout must be wrapped in try-catch to survive disposal');
  });

  it('popout registers onDidChangeViewState to catch window-close', () => {
    expect(provider).to.include('onDidChangeViewState',
      'popout must register onDidChangeViewState to handle secondary window close');
  });

  it('onDidChangeViewState defers dispose to avoid extension host crash', () => {
    expect(provider).to.include('setTimeout',
      'onDidChangeViewState must defer panel.dispose() via setTimeout');
  });

  it('restorePopout sends popoutClosed on dispose', () => {
    const restoreIdx = provider.indexOf('public restorePopout');
    expect(restoreIdx).to.not.equal(-1, 'restorePopout method missing');
    const restoreSlice = provider.slice(restoreIdx, restoreIdx + 900);
    expect(restoreSlice).to.include("type: 'popoutClosed'",
      'restorePopout dispose handler must send popoutClosed');
  });
});
