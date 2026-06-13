import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { log, logError } from './logger';

type VoiceState = 'idle' | 'recording' | 'transcribing';

// Single-file static ffmpeg binaries — eugeneware/ffmpeg-static releases.
// Asset names match {platform}-{arch} exactly (no extension, just the binary).
const FFMPEG_RELEASES_API = 'https://api.github.com/repos/eugeneware/ffmpeg-static/releases/latest';

function _ffmpegAssetName(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `${process.platform}-${arch}`; // e.g. "win32-x64", "darwin-arm64", "linux-x64"
}

async function _fetchFfmpegAssetUrl(): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(FFMPEG_RELEASES_API, { headers: { 'User-Agent': 'grom-vscode' } }, res => {
      let body = '';
      res.on('data', (d: Buffer) => body += d);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const assets: any[] = data.assets ?? [];
          const base = _ffmpegAssetName(); // e.g. "win32-x64"
          // Try several name formats the repo has used across releases
          const candidates = [base, `ffmpeg-${base}`, `${base}.exe`, `ffmpeg-${base}.exe`];
          const asset = assets.find((a: any) => candidates.includes(a.name))
            // fuzzy fallback: contains both platform and arch substrings
            ?? assets.find((a: any) => a.name.includes(process.platform) && a.name.includes(process.arch === 'arm64' ? 'arm64' : 'x64'));
          if (!asset) {
            const available = assets.map((a: any) => a.name).join(', ') || '(none)';
            reject(new Error(`No ffmpeg build for ${base}. Assets in release: ${available}`));
          } else {
            resolve(asset.browser_download_url as string);
          }
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Per-session device caches — cleared on each new recording so a reconnected mic is picked up.
// Reset by VoiceManager._start() before spawning ffmpeg.
let _cachedWindowsDevice: string | undefined;
let _cachedMacDevice: string | undefined;
let _cachedLinuxBackend: string | undefined;

export function resetDeviceCache() {
  _cachedWindowsDevice = undefined;
  _cachedMacDevice = undefined;
  _cachedLinuxBackend = undefined;
}

// Windows: enumerate DirectShow audio capture devices, return the first one found
async function _findWindowsAudioDevice(ffmpegPath: string): Promise<string> {
  if (_cachedWindowsDevice !== undefined) return _cachedWindowsDevice;
  return new Promise(resolve => {
    const proc = cp.spawn(ffmpegPath, ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    proc.stderr!.on('data', (d: Buffer) => (stderr += d));
    proc.on('close', () => {
      // Device lines look like:  [dshow @ ...] "Microphone (Realtek Audio)" (audio)
      for (const line of stderr.split('\n')) {
        if (line.includes('(audio)') && !line.includes('Alternative name')) {
          const m = line.match(/"([^"]+)"/);
          if (m) { _cachedWindowsDevice = m[1]; resolve(m[1]); return; }
        }
      }
      _cachedWindowsDevice = '';
      resolve('');
    });
    proc.on('error', () => resolve(''));
  });
}

// macOS: enumerate avfoundation audio devices, return the index of the first microphone
async function _findMacAudioDevice(ffmpegPath: string): Promise<string> {
  if (_cachedMacDevice !== undefined) return _cachedMacDevice;
  return new Promise(resolve => {
    const proc = cp.spawn(ffmpegPath, ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    proc.stderr!.on('data', (d: Buffer) => (stderr += d));
    proc.on('close', () => {
      // Lines look like: [AVFoundation indev @ 0xADDR] [0] Built-in Microphone
      // We want the standalone [N] at the start of the device name portion, not the hex address.
      // Match lines that contain ] [<digits>] <name> — the device index block follows the address block.
      let inAudio = false;
      for (const line of stderr.split('\n')) {
        if (line.includes('AVFoundation audio devices')) { inAudio = true; continue; }
        if (!inAudio) continue;
        // Match "...] [0] Some Mic Name" — two consecutive bracket groups, second is pure digits
        const m = line.match(/\]\s*\[(\d+)\]\s*\S/);
        if (m) { _cachedMacDevice = m[1]; resolve(m[1]); return; }
      }
      _cachedMacDevice = '0';
      resolve('0');
    });
    proc.on('error', () => { _cachedMacDevice = '0'; resolve('0'); });
  });
}

// Linux: probe for a running PulseAudio/PipeWire daemon, then ALSA
async function _findLinuxBackend(): Promise<string> {
  if (_cachedLinuxBackend !== undefined) return _cachedLinuxBackend;
  // pactl info exits 0 only when the daemon is actually reachable (PipeWire or PulseAudio)
  const pulseRunning = await _execSucceeds('pactl info');
  if (pulseRunning) { _cachedLinuxBackend = 'pulse'; return 'pulse'; }
  // ALSA: check for at least one capture device
  const alsaHasCap = await _execSucceeds('arecord -l');
  _cachedLinuxBackend = alsaHasCap ? 'alsa' : 'pulse';
  return _cachedLinuxBackend;
}

function _execSucceeds(cmd: string): Promise<boolean> {
  return new Promise(resolve => {
    cp.exec(cmd, { timeout: 2000 }, (err) => resolve(!err));
  });
}

// Platform-specific microphone capture arguments for ffmpeg
async function captureArgs(ffmpegPath: string): Promise<string[]> {
  if (process.platform === 'darwin') {
    const idx = await _findMacAudioDevice(ffmpegPath);
    log(`[voice] macOS avfoundation audio device index: ${idx}`);
    return ['-f', 'avfoundation', '-i', `:${idx}`];
  }

  if (process.platform === 'linux') {
    const backend = await _findLinuxBackend();
    log(`[voice] Linux audio backend: ${backend}`);
    if (backend === 'alsa') return ['-f', 'alsa', '-i', 'default'];
    return ['-f', 'pulse', '-i', 'default'];
  }

  // Windows
  const device = await _findWindowsAudioDevice(ffmpegPath);
  log(`[voice] Windows dshow device: ${device || '(none found)'}`);
  if (device) return ['-f', 'dshow', '-i', `audio=${device}`];
  return ['-f', 'wasapi', '-i', '0']; // last-resort fallback
}

function _localFfmpegPath(storageDir: string): string {
  return path.join(storageDir, 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

export function findFfmpeg(storageDir: string): string | null {
  // 1. Env var or VS Code setting override
  const override = process.env.GROM_FFMPEG ?? process.env.FFMPEG_PATH ??
    vscode.workspace.getConfiguration('grom').get<string>('ffmpegPath', '').trim();
  if (override && fs.existsSync(override)) return override;

  // 2. Previously downloaded binary
  const local = _localFfmpegPath(storageDir);
  if (fs.existsSync(local)) return local;

  // 3. System PATH
  try {
    const cmd = process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg';
    const found = cp.execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0].trim();
    if (found && fs.existsSync(found)) return found;
  } catch {}

  return null;
}

function _downloadFile(url: string, dest: string, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (u: string) => {
      https.get(u, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return follow(res.headers.location!);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const file = fs.createWriteStream(dest);
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (total) onProgress(Math.round(received / total * 100));
        });
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', (e) => { fs.unlink(dest, () => {}); reject(e); });
      }).on('error', reject);
    };
    follow(url);
  });
}

export async function downloadFfmpeg(storageDir: string, onProgress: (pct: number) => void): Promise<string> {
  const url = await _fetchFfmpegAssetUrl();

  const dir = path.join(storageDir, 'ffmpeg');
  fs.mkdirSync(dir, { recursive: true });
  const dest = _localFfmpegPath(storageDir);

  await _downloadFile(url, dest, onProgress);
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);

  return dest;
}

export class VoiceManager {
  private _state: VoiceState = 'idle';
  private _proc: cp.ChildProcess | null = null;
  private _allPcm: Buffer[] = [];
  private _maxRecordTimer: NodeJS.Timeout | null = null;
  private _chunkTimer: NodeJS.Timeout | null = null;
  private _sentPcmLength: number = 0;
  private static readonly MAX_RECORD_MS = 30_000;
  private static readonly CHUNK_BYTES = 16000 * 4 * 3; // 3s of f32le @ 16kHz

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _post: (msg: object) => void
  ) {}

  async toggle() {
    console.log('[grom voice] toggle called, state:', this._state);
    if (this._state === 'transcribing') return;
    if (this._state === 'recording') this._stop();
    else await this._start();
  }

  async downloadFfmpeg() {
    try {
      this._post({ type: 'voiceDownload', text: 'Downloading ffmpeg…' });
      await downloadFfmpeg(this._context.globalStorageUri.fsPath, pct => {
        this._post({ type: 'voiceDownload', text: `Downloading ffmpeg… ${pct}%` });
      });
      this._post({ type: 'voiceDownload', text: null });
      this._post({ type: 'voiceFfmpegReady' });
    } catch (e: any) {
      logError('[voice] ffmpeg download failed', e);
      this._post({ type: 'voiceDownload', text: null });
      this._post({ type: 'voiceError', message: `ffmpeg download failed: ${e.message}` });
    }
  }

  async removeModel() {
    this._post({ type: 'voiceClearCache' });
    this._post({ type: 'voiceModelRemoved' });
  }

  dispose() {
    this._killProc();
  }

  private _setState(s: VoiceState) {
    log(`[voice] state: ${this._state} → ${s}`);
    this._state = s;
    this._post({ type: 'voiceState', state: s });
  }

  private async _start() {
    // Set state immediately — acts as a lock so a rapid second toggle() call sees 'recording'
    // and calls _stop() instead of spawning a second ffmpeg process.
    this._setState('recording');

    const ffmpegPath = findFfmpeg(this._context.globalStorageUri.fsPath);
    console.log('[grom voice] _start, ffmpegPath:', ffmpegPath);
    if (!ffmpegPath) {
      this._setState('idle');
      this._post({ type: 'voiceNoFfmpeg' });
      return;
    }

    this._allPcm = [];
    this._sentPcmLength = 0;
    resetDeviceCache();

    const captureArgList = await captureArgs(ffmpegPath);
    // If _stop() was called during the async captureArgs() gap, bail — state is already 'idle'
    if (this._state !== 'recording') return;

    const args = [...captureArgList, '-ar', '16000', '-ac', '1', '-f', 'f32le', 'pipe:1'];

    try {
      this._proc = cp.spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e: any) {
      this._setState('idle');
      this._post({ type: 'voiceError', message: `Failed to start ffmpeg: ${e.message}` });
      return;
    }

    this._post({ type: 'voiceAudioStart' }); // tell webview to reset accumulator + start pipeline load

    // Auto-stop after 30s to avoid very long ONNX inference jobs freezing the UI
    this._maxRecordTimer = setTimeout(() => { if (this._state === 'recording') this._stop(); }, VoiceManager.MAX_RECORD_MS);

    // Send 5-second chunks for progressive transcription
    this._chunkTimer = setInterval(() => {
      const total = this._allPcm.reduce((s, b) => s + b.length, 0);
      if (total - this._sentPcmLength >= VoiceManager.CHUNK_BYTES) {
        const combined = Buffer.concat(this._allPcm);
        const chunk = combined.slice(this._sentPcmLength, this._sentPcmLength + VoiceManager.CHUNK_BYTES);
        this._sentPcmLength += VoiceManager.CHUNK_BYTES;
        this._sendPcm(chunk, false);
      }
    }, 1000);

    let _firstChunk = true;
    this._proc.stdout!.on('data', (data: Buffer) => {
      if (_firstChunk) { console.log('[grom voice] ffmpeg audio flowing, first chunk bytes:', data.length); _firstChunk = false; }
      this._allPcm.push(data);
    });

    this._proc.on('error', (e: any) => {
      console.log('[grom voice] ffmpeg process error:', e.message);
      logError('[voice] ffmpeg error', e);
      this._post({ type: 'voiceError', message: e.message });
      this._setState('idle');
      this._proc = null;
    });

    this._proc.on('close', (code: number) => {
      console.log('[grom voice] ffmpeg closed, code:', code, 'total pcm bytes:', this._allPcm.reduce((s, b) => s + b.length, 0));
      this._proc = null;
    });
  }

  private _stop() {
    if (this._maxRecordTimer) { clearTimeout(this._maxRecordTimer); this._maxRecordTimer = null; }
    if (this._chunkTimer) { clearInterval(this._chunkTimer); this._chunkTimer = null; }
    this._setState('transcribing');
    this._killProc();

    if (this._allPcm.length === 0) {
      this._setState('idle');
      return;
    }

    const combined = Buffer.concat(this._allPcm);
    const remaining = combined.slice(this._sentPcmLength);
    this._allPcm = [];
    this._sentPcmLength = 0;

    if (remaining.length === 0) {
      // All audio already sent as chunks — signal end with empty final
      this._sendPcm(Buffer.alloc(0), true);
    } else {
      this._sendPcm(remaining, true);
    }
    // Reset host state to idle — the webview manages its own visual transcribing state
    this._state = 'idle';
  }

  private _sendPcm(buf: Buffer, isFinal: boolean) {
    // Encode as base64 — postMessage only supports JSON-serialisable values
    this._post({ type: 'voiceAudio', pcm: buf.toString('base64'), isFinal });
  }

  private _killProc() {
    if (this._proc) {
      try { this._proc.kill(); } catch {}
      this._proc = null;
    }
  }
}
