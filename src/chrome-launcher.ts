import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import type { ChromeExecutable, ChromeKind, LaunchOptions, RunningChrome } from './types.js';

// ── Executable Detection ──

const CHROMIUM_BUNDLE_IDS = new Set([
  'com.google.Chrome',
  'com.google.Chrome.beta',
  'com.google.Chrome.canary',
  'com.google.Chrome.dev',
  'com.brave.Browser',
  'com.brave.Browser.beta',
  'com.brave.Browser.nightly',
  'com.microsoft.Edge',
  'com.microsoft.EdgeBeta',
  'com.microsoft.EdgeDev',
  'com.microsoft.EdgeCanary',
  'org.chromium.Chromium',
  'com.vivaldi.Vivaldi',
  'com.operasoftware.Opera',
  'com.operasoftware.OperaGX',
  'com.yandex.desktop.yandex-browser',
  'company.thebrowser.Browser',
]);

const CHROMIUM_DESKTOP_IDS = new Set([
  'google-chrome.desktop',
  'google-chrome-beta.desktop',
  'google-chrome-unstable.desktop',
  'brave-browser.desktop',
  'microsoft-edge.desktop',
  'microsoft-edge-beta.desktop',
  'microsoft-edge-dev.desktop',
  'microsoft-edge-canary.desktop',
  'chromium.desktop',
  'chromium-browser.desktop',
  'vivaldi.desktop',
  'vivaldi-stable.desktop',
  'opera.desktop',
  'opera-gx.desktop',
  'yandex-browser.desktop',
  'org.chromium.Chromium.desktop',
]);

const CHROMIUM_EXE_NAMES = new Set([
  'chrome.exe', 'msedge.exe', 'brave.exe', 'brave-browser.exe', 'chromium.exe',
  'vivaldi.exe', 'opera.exe', 'launcher.exe', 'yandex.exe', 'yandexbrowser.exe',
  'google chrome', 'google chrome canary', 'brave browser', 'microsoft edge',
  'chromium', 'chrome', 'brave', 'msedge', 'brave-browser',
  'google-chrome', 'google-chrome-stable', 'google-chrome-beta', 'google-chrome-unstable',
  'microsoft-edge', 'microsoft-edge-beta', 'microsoft-edge-dev', 'microsoft-edge-canary',
  'chromium-browser', 'vivaldi', 'vivaldi-stable', 'opera', 'opera-stable', 'opera-gx',
  'yandex-browser',
]);

function fileExists(filePath: string): boolean {
  try { return fs.existsSync(filePath); } catch { return false; }
}

function execText(command: string, args: string[], timeoutMs = 1200): string | null {
  try {
    const output = execFileSync(command, args, {
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    return String(output ?? '').trim() || null;
  } catch { return null; }
}

function inferKindFromIdentifier(identifier: string): ChromeKind {
  const id = identifier.toLowerCase();
  if (id.includes('brave')) return 'brave';
  if (id.includes('edge')) return 'edge';
  if (id.includes('chromium')) return 'chromium';
  if (id.includes('canary')) return 'canary';
  if (id.includes('opera') || id.includes('vivaldi') || id.includes('yandex') || id.includes('thebrowser')) return 'chromium';
  return 'chrome';
}

function inferKindFromExeName(name: string): ChromeKind {
  const lower = name.toLowerCase();
  if (lower.includes('brave')) return 'brave';
  if (lower.includes('edge') || lower.includes('msedge')) return 'edge';
  if (lower.includes('chromium')) return 'chromium';
  if (lower.includes('canary') || lower.includes('sxs')) return 'canary';
  if (lower.includes('opera') || lower.includes('vivaldi') || lower.includes('yandex')) return 'chromium';
  return 'chrome';
}

function findFirstExe(candidates: ChromeExecutable[]): ChromeExecutable | null {
  for (const c of candidates) if (fileExists(c.path)) return c;
  return null;
}

// ── Mac Detection ──

function detectDefaultBrowserBundleIdMac(): string | null {
  const plistPath = path.join(os.homedir(), 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist');
  if (!fileExists(plistPath)) return null;
  const handlersRaw = execText('/usr/bin/plutil', ['-extract', 'LSHandlers', 'json', '-o', '-', '--', plistPath], 2000);
  if (!handlersRaw) return null;
  let handlers: any[];
  try { handlers = JSON.parse(handlersRaw); } catch { return null; }
  if (!Array.isArray(handlers)) return null;

  const resolveScheme = (scheme: string): string | null => {
    let candidate: string | null = null;
    for (const entry of handlers) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.LSHandlerURLScheme !== scheme) continue;
      const role = (typeof entry.LSHandlerRoleAll === 'string' && entry.LSHandlerRoleAll) ||
                   (typeof entry.LSHandlerRoleViewer === 'string' && entry.LSHandlerRoleViewer) || null;
      if (role) candidate = role;
    }
    return candidate;
  };
  return resolveScheme('http') ?? resolveScheme('https');
}

function detectDefaultChromiumMac(): ChromeExecutable | null {
  const bundleId = detectDefaultBrowserBundleIdMac();
  if (!bundleId || !CHROMIUM_BUNDLE_IDS.has(bundleId)) return null;
  const appPathRaw = execText('/usr/bin/osascript', ['-e', `POSIX path of (path to application id "${bundleId}")`]);
  if (!appPathRaw) return null;
  const appPath = appPathRaw.trim().replace(/\/$/, '');
  const exeName = execText('/usr/bin/defaults', ['read', path.join(appPath, 'Contents', 'Info'), 'CFBundleExecutable']);
  if (!exeName) return null;
  const exePath = path.join(appPath, 'Contents', 'MacOS', exeName.trim());
  if (!fileExists(exePath)) return null;
  return { kind: inferKindFromIdentifier(bundleId), path: exePath };
}

function findChromeMac(): ChromeExecutable | null {
  return findFirstExe([
    { kind: 'chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    { kind: 'chrome', path: path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome') },
    { kind: 'brave', path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
    { kind: 'brave', path: path.join(os.homedir(), 'Applications/Brave Browser.app/Contents/MacOS/Brave Browser') },
    { kind: 'edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    { kind: 'edge', path: path.join(os.homedir(), 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge') },
    { kind: 'chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
    { kind: 'chromium', path: path.join(os.homedir(), 'Applications/Chromium.app/Contents/MacOS/Chromium') },
    { kind: 'canary', path: '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary' },
    { kind: 'canary', path: path.join(os.homedir(), 'Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary') },
  ]);
}

// ── Linux Detection ──

function detectDefaultChromiumLinux(): ChromeExecutable | null {
  const desktopId = execText('xdg-settings', ['get', 'default-web-browser']) ||
    execText('xdg-mime', ['query', 'default', 'x-scheme-handler/http']);
  if (!desktopId) return null;
  const trimmed = desktopId.trim();
  if (!CHROMIUM_DESKTOP_IDS.has(trimmed)) return null;

  const searchDirs = [
    path.join(os.homedir(), '.local', 'share', 'applications'),
    '/usr/local/share/applications',
    '/usr/share/applications',
    '/var/lib/snapd/desktop/applications',
  ];
  let desktopPath: string | null = null;
  for (const dir of searchDirs) {
    const candidate = path.join(dir, trimmed);
    if (fileExists(candidate)) { desktopPath = candidate; break; }
  }
  if (!desktopPath) return null;

  let execLine: string | null = null;
  try {
    const lines = fs.readFileSync(desktopPath, 'utf8').split(/\r?\n/);
    for (const line of lines) if (line.startsWith('Exec=')) { execLine = line.slice(5).trim(); break; }
  } catch {}
  if (!execLine) return null;

  const tokens = execLine.split(/\s+/);
  let command: string | null = null;
  for (const token of tokens) {
    if (!token || token === 'env' || (token.includes('=') && !token.startsWith('/'))) continue;
    command = token.replace(/^["']|["']$/g, '');
    break;
  }
  if (!command) return null;

  const resolved = command.startsWith('/') ? command : (execText('which', [command], 800)?.trim() ?? null);
  if (!resolved) return null;
  const exeName = path.posix.basename(resolved).toLowerCase();
  if (!CHROMIUM_EXE_NAMES.has(exeName)) return null;
  return { kind: inferKindFromExeName(exeName), path: resolved };
}

function findChromeLinux(): ChromeExecutable | null {
  return findFirstExe([
    { kind: 'chrome', path: '/usr/bin/google-chrome' },
    { kind: 'chrome', path: '/usr/bin/google-chrome-stable' },
    { kind: 'chrome', path: '/usr/bin/chrome' },
    { kind: 'brave', path: '/usr/bin/brave-browser' },
    { kind: 'brave', path: '/usr/bin/brave-browser-stable' },
    { kind: 'brave', path: '/usr/bin/brave' },
    { kind: 'brave', path: '/snap/bin/brave' },
    { kind: 'edge', path: '/usr/bin/microsoft-edge' },
    { kind: 'edge', path: '/usr/bin/microsoft-edge-stable' },
    { kind: 'chromium', path: '/usr/bin/chromium' },
    { kind: 'chromium', path: '/usr/bin/chromium-browser' },
    { kind: 'chromium', path: '/snap/bin/chromium' },
  ]);
}

// ── Windows Detection ──

function findChromeWindows(): ChromeExecutable | null {
  const localAppData = process.env.LOCALAPPDATA ?? '';
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const j = path.win32.join;
  const candidates: ChromeExecutable[] = [];
  if (localAppData) {
    candidates.push({ kind: 'chrome', path: j(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') });
    candidates.push({ kind: 'brave', path: j(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') });
    candidates.push({ kind: 'edge', path: j(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe') });
    candidates.push({ kind: 'chromium', path: j(localAppData, 'Chromium', 'Application', 'chrome.exe') });
    candidates.push({ kind: 'canary', path: j(localAppData, 'Google', 'Chrome SxS', 'Application', 'chrome.exe') });
  }
  candidates.push({ kind: 'chrome', path: j(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') });
  candidates.push({ kind: 'chrome', path: j(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe') });
  candidates.push({ kind: 'brave', path: j(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') });
  candidates.push({ kind: 'brave', path: j(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') });
  candidates.push({ kind: 'edge', path: j(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') });
  candidates.push({ kind: 'edge', path: j(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') });
  return findFirstExe(candidates);
}

// ── Resolve Executable ──

export function resolveBrowserExecutable(opts?: { executablePath?: string }): ChromeExecutable | null {
  if (opts?.executablePath) {
    if (!fileExists(opts.executablePath)) throw new Error(`executablePath not found: ${opts.executablePath}`);
    return { kind: 'custom', path: opts.executablePath };
  }
  const platform = process.platform;
  // Try default browser first
  if (platform === 'darwin') return detectDefaultChromiumMac() ?? findChromeMac();
  if (platform === 'linux') return detectDefaultChromiumLinux() ?? findChromeLinux();
  if (platform === 'win32') return findChromeWindows();
  return null;
}

// ── Port Check ──

async function ensurePortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tester = net.createServer()
      .once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') reject(new Error(`Port ${port} is already in use`));
        else reject(err);
      })
      .once('listening', () => { tester.close(() => resolve()); })
      .listen(port);
  });
}

// ── Profile Decoration ──

function safeReadJson(filePath: string): Record<string, any> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed;
  } catch { return null; }
}

function safeWriteJson(filePath: string, data: Record<string, any>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function setDeep(obj: Record<string, any>, keys: string[], value: any): void {
  let node = obj;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]!] = value;
}

function parseHexRgbToSignedArgbInt(hex: string): number | null {
  const cleaned = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) return null;
  const argbUnsigned = (255 << 24) | Number.parseInt(cleaned, 16);
  return argbUnsigned > 2147483647 ? argbUnsigned - 4294967296 : argbUnsigned;
}

function decorateProfile(userDataDir: string, name: string, color: string): void {
  const colorInt = parseHexRgbToSignedArgbInt(color);
  const localStatePath = path.join(userDataDir, 'Local State');
  const preferencesPath = path.join(userDataDir, 'Default', 'Preferences');

  const localState = safeReadJson(localStatePath) ?? {};
  setDeep(localState, ['profile', 'info_cache', 'Default', 'name'], name);
  setDeep(localState, ['profile', 'info_cache', 'Default', 'shortcut_name'], name);
  setDeep(localState, ['profile', 'info_cache', 'Default', 'user_name'], name);
  setDeep(localState, ['profile', 'info_cache', 'Default', 'profile_color'], color);
  if (colorInt != null) {
    setDeep(localState, ['profile', 'info_cache', 'Default', 'profile_color_seed'], colorInt);
    setDeep(localState, ['profile', 'info_cache', 'Default', 'profile_highlight_color'], colorInt);
  }
  safeWriteJson(localStatePath, localState);

  const prefs = safeReadJson(preferencesPath) ?? {};
  setDeep(prefs, ['profile', 'name'], name);
  setDeep(prefs, ['profile', 'profile_color'], color);
  if (colorInt != null) {
    setDeep(prefs, ['autogenerated', 'theme', 'color'], colorInt);
    setDeep(prefs, ['browser', 'theme', 'user_color2'], colorInt);
  }
  safeWriteJson(preferencesPath, prefs);
}

function ensureCleanExit(userDataDir: string): void {
  const preferencesPath = path.join(userDataDir, 'Default', 'Preferences');
  const prefs = safeReadJson(preferencesPath) ?? {};
  setDeep(prefs, ['exit_type'], 'Normal');
  setDeep(prefs, ['exited_cleanly'], true);
  safeWriteJson(preferencesPath, prefs);
}

// ── Launch Chrome ──

const DEFAULT_CDP_PORT = 9222;
const DEFAULT_PROFILE_NAME = 'browserclaw';
const DEFAULT_PROFILE_COLOR = '#FF4500';

function resolveUserDataDir(profileName: string): string {
  const configDir = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(configDir, 'browserclaw', 'profiles', profileName, 'user-data');
}

export async function isChromeReachable(cdpUrl: string, timeoutMs = 500): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${cdpUrl.replace(/\/+$/, '')}/json/version`, { signal: ctrl.signal });
    return res.ok;
  } catch { return false; }
  finally { clearTimeout(t); }
}

export async function getChromeWebSocketUrl(cdpUrl: string, timeoutMs = 500): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${cdpUrl.replace(/\/+$/, '')}/json/version`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json() as { webSocketDebuggerUrl?: string };
    return String(data?.webSocketDebuggerUrl ?? '').trim() || null;
  } catch { return null; }
  finally { clearTimeout(t); }
}

export async function launchChrome(opts: LaunchOptions = {}): Promise<RunningChrome> {
  const cdpPort = opts.cdpPort ?? DEFAULT_CDP_PORT;
  await ensurePortAvailable(cdpPort);

  const exe = resolveBrowserExecutable({ executablePath: opts.executablePath });
  if (!exe) throw new Error('No supported browser found (Chrome/Brave/Edge/Chromium). Install one or provide executablePath.');

  const profileName = opts.profileName ?? DEFAULT_PROFILE_NAME;
  const userDataDir = opts.userDataDir ?? resolveUserDataDir(profileName);
  fs.mkdirSync(userDataDir, { recursive: true });

  const spawnChrome = () => {
    const args = [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-features=Translate,MediaRouter',
      '--disable-blink-features=AutomationControlled',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      '--password-store=basic',
    ];
    if (opts.headless) {
      args.push('--headless=new', '--disable-gpu');
    }
    if (opts.noSandbox) {
      args.push('--no-sandbox', '--disable-setuid-sandbox');
    }
    if (process.platform === 'linux') args.push('--disable-dev-shm-usage');
    if (opts.chromeArgs?.length) args.push(...opts.chromeArgs);
    args.push('about:blank');
    return spawn(exe.path, args, {
      stdio: 'pipe',
      env: { ...process.env, HOME: os.homedir() },
    });
  };

  const startedAt = Date.now();
  const localStatePath = path.join(userDataDir, 'Local State');
  const preferencesPath = path.join(userDataDir, 'Default', 'Preferences');

  // Bootstrap run if profile doesn't exist yet
  if (!fileExists(localStatePath) || !fileExists(preferencesPath)) {
    const bootstrap = spawnChrome();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (fileExists(localStatePath) && fileExists(preferencesPath)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    try { bootstrap.kill('SIGTERM'); } catch {}
    const exitDeadline = Date.now() + 5000;
    while (Date.now() < exitDeadline) {
      if (bootstrap.exitCode != null) break;
      await new Promise(r => setTimeout(r, 50));
    }
    if (bootstrap.exitCode == null) {
      try { bootstrap.kill('SIGKILL'); } catch {}
    }
  }

  // Decorate profile
  try {
    decorateProfile(userDataDir, profileName, opts.profileColor ?? DEFAULT_PROFILE_COLOR);
  } catch {}

  // Ensure clean exit state
  try { ensureCleanExit(userDataDir); } catch {}

  // Launch for real
  const proc = spawnChrome();
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;

  // Wait for Chrome to be ready
  const readyDeadline = Date.now() + 15000;
  while (Date.now() < readyDeadline) {
    if (await isChromeReachable(cdpUrl, 500)) break;
    await new Promise(r => setTimeout(r, 200));
  }

  if (!await isChromeReachable(cdpUrl, 500)) {
    try { proc.kill('SIGKILL'); } catch {}
    throw new Error(`Failed to start Chrome CDP on port ${cdpPort}. Chrome may not have started correctly.`);
  }

  return {
    pid: proc.pid ?? -1,
    exe,
    userDataDir,
    cdpPort,
    startedAt,
    proc,
  };
}

export async function stopChrome(running: RunningChrome, timeoutMs = 2500): Promise<void> {
  const proc = running.proc;
  if (proc.exitCode != null) return;
  try { proc.kill('SIGTERM'); } catch {}
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode != null) return;
    await new Promise(r => setTimeout(r, 100));
  }
  try { proc.kill('SIGKILL'); } catch {}
}
