import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { assertCdpEndpointAllowed } from './security.js';
import type { ChromeExecutable, ChromeKind, LaunchOptions, RunningChrome, SsrfPolicy } from './types.js';

// ── Process Tree Kill ──

/**
 * Kill a process and its children. Uses process group kill on Unix when the
 * process was spawned with `detached: true`, falls back to direct kill.
 */
function killProcessTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && proc.pid !== undefined) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // Process group kill failed — fall back to direct kill
    }
  }
  try {
    proc.kill(signal);
  } catch {
    /* process may already be dead */
  }
}

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
  'com.microsoft.edgemac',
  'com.microsoft.edgemac.beta',
  'com.microsoft.edgemac.dev',
  'com.microsoft.edgemac.canary',
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
  'chrome.exe',
  'msedge.exe',
  'brave.exe',
  'brave-browser.exe',
  'chromium.exe',
  'vivaldi.exe',
  'opera.exe',
  'launcher.exe',
  'yandex.exe',
  'yandexbrowser.exe',
  'google chrome',
  'google chrome canary',
  'brave browser',
  'microsoft edge',
  'chromium',
  'chrome',
  'brave',
  'msedge',
  'brave-browser',
  'google-chrome',
  'google-chrome-stable',
  'google-chrome-beta',
  'google-chrome-unstable',
  'microsoft-edge',
  'microsoft-edge-beta',
  'microsoft-edge-dev',
  'microsoft-edge-canary',
  'chromium-browser',
  'vivaldi',
  'vivaldi-stable',
  'opera',
  'opera-stable',
  'opera-gx',
  'yandex-browser',
]);

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function execText(command: string, args: string[], timeoutMs = 1200, maxBuffer = 1024 * 1024): string | null {
  try {
    const output = execFileSync(command, args, {
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer,
    });
    return output.trim() || null;
  } catch {
    return null;
  }
}

function inferKindFromIdentifier(identifier: string): ChromeKind {
  const id = identifier.toLowerCase();
  if (id.includes('brave')) return 'brave';
  if (id.includes('edge')) return 'edge';
  if (id.includes('chromium')) return 'chromium';
  if (id.includes('canary')) return 'canary';
  if (id.includes('opera') || id.includes('vivaldi') || id.includes('yandex') || id.includes('thebrowser'))
    return 'chromium';
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
  const plistPath = path.join(
    os.homedir(),
    'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist',
  );
  if (!fileExists(plistPath)) return null;
  const handlersRaw = execText(
    '/usr/bin/plutil',
    ['-extract', 'LSHandlers', 'json', '-o', '-', '--', plistPath],
    2000,
    5 * 1024 * 1024,
  );
  if (handlersRaw === null) return null;
  let handlers: unknown[];
  try {
    const parsed: unknown = JSON.parse(handlersRaw);
    if (!Array.isArray(parsed)) return null;
    handlers = parsed;
  } catch {
    return null;
  }

  const resolveScheme = (scheme: string): string | null => {
    let candidate: string | null = null;
    for (const entry of handlers) {
      if (entry === null || entry === undefined || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      if (rec.LSHandlerURLScheme !== scheme) continue;
      const role =
        (typeof rec.LSHandlerRoleAll === 'string' ? rec.LSHandlerRoleAll : null) ??
        (typeof rec.LSHandlerRoleViewer === 'string' ? rec.LSHandlerRoleViewer : null) ??
        null;
      if (role !== null) candidate = role;
    }
    return candidate;
  };
  return resolveScheme('http') ?? resolveScheme('https');
}

function detectDefaultChromiumMac(): ChromeExecutable | null {
  const bundleId = detectDefaultBrowserBundleIdMac();
  if (bundleId === null || !CHROMIUM_BUNDLE_IDS.has(bundleId)) return null;
  const appPathRaw = execText('/usr/bin/osascript', ['-e', `POSIX path of (path to application id "${bundleId}")`]);
  if (appPathRaw === null) return null;
  const appPath = appPathRaw.trim().replace(/\/$/, '');
  const exeName = execText('/usr/bin/defaults', ['read', path.join(appPath, 'Contents', 'Info'), 'CFBundleExecutable']);
  if (exeName === null) return null;
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
    {
      kind: 'canary',
      path: path.join(os.homedir(), 'Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'),
    },
  ]);
}

function splitExecLine(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';
  for (const ch of line) {
    if ((ch === '"' || ch === "'") && (!inQuotes || ch === quoteChar)) {
      if (inQuotes) {
        inQuotes = false;
        quoteChar = '';
      } else {
        inQuotes = true;
        quoteChar = ch;
      }
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

// ── Linux Detection ──

function detectDefaultChromiumLinux(): ChromeExecutable | null {
  const desktopId =
    execText('xdg-settings', ['get', 'default-web-browser']) ??
    execText('xdg-mime', ['query', 'default', 'x-scheme-handler/http']);
  if (desktopId === null) return null;
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
    if (fileExists(candidate)) {
      desktopPath = candidate;
      break;
    }
  }
  if (desktopPath === null) return null;

  let execLine: string | null = null;
  try {
    const lines = fs.readFileSync(desktopPath, 'utf8').split(/\r?\n/);
    for (const line of lines)
      if (line.startsWith('Exec=')) {
        execLine = line.slice(5).trim();
        break;
      }
  } catch {
    /* no exec line found */
  }
  if (execLine === null) return null;

  const tokens = splitExecLine(execLine);
  let command: string | null = null;
  for (const token of tokens) {
    if (!token || token === 'env' || (token.includes('=') && !token.startsWith('/') && !token.includes('\\'))) continue;
    command = token.replace(/^["']|["']$/g, '');
    break;
  }
  if (command === null) return null;

  const resolved = command.startsWith('/') ? command : (execText('which', [command], 800)?.trim() ?? null);
  if (resolved === null || resolved === '') return null;
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
    candidates.push({
      kind: 'brave',
      path: j(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    });
    candidates.push({ kind: 'edge', path: j(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe') });
    candidates.push({ kind: 'chromium', path: j(localAppData, 'Chromium', 'Application', 'chrome.exe') });
    candidates.push({ kind: 'canary', path: j(localAppData, 'Google', 'Chrome SxS', 'Application', 'chrome.exe') });
  }
  candidates.push({ kind: 'chrome', path: j(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') });
  candidates.push({ kind: 'chrome', path: j(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe') });
  candidates.push({
    kind: 'brave',
    path: j(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  });
  candidates.push({
    kind: 'brave',
    path: j(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  });
  candidates.push({ kind: 'edge', path: j(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') });
  candidates.push({ kind: 'edge', path: j(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') });
  return findFirstExe(candidates);
}

// ── Windows Default Browser Detection ──

function readWindowsProgId(): string | null {
  const output = execText('reg', [
    'query',
    'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice',
    '/v',
    'ProgId',
  ]);
  if (output === null) return null;
  return /ProgId\s+REG_\w+\s+(.+)$/im.exec(output)?.[1]?.trim() ?? null;
}

function readWindowsCommandForProgId(progId: string): string | null {
  const output = execText('reg', [
    'query',
    progId === 'http' ? 'HKCR\\http\\shell\\open\\command' : `HKCR\\${progId}\\shell\\open\\command`,
    '/ve',
  ]);
  if (output === null) return null;
  return /REG_\w+\s+(.+)$/im.exec(output)?.[1]?.trim() ?? null;
}

function expandWindowsEnvVars(value: string): string {
  return value.replace(/%([^%]+)%/g, (_match, name: string) => {
    const key = name.trim();
    return key !== '' ? (process.env[key] ?? `%${key}%`) : _match;
  });
}

function extractWindowsExecutablePath(command: string): string | null {
  const quoted = /"([^"]+\.exe)"/i.exec(command);
  if (quoted?.[1] !== undefined) return quoted[1];
  const unquoted = /([^\s]+\.exe)/i.exec(command);
  if (unquoted?.[1] !== undefined) return unquoted[1];
  return null;
}

function detectDefaultChromiumWindows(): ChromeExecutable | null {
  const progId = readWindowsProgId();
  const command = (progId !== null ? readWindowsCommandForProgId(progId) : null) ?? readWindowsCommandForProgId('http');
  if (command === null) return null;
  const exePath = extractWindowsExecutablePath(expandWindowsEnvVars(command));
  if (exePath === null) return null;
  if (!fileExists(exePath)) return null;
  const exeName = path.win32.basename(exePath).toLowerCase();
  if (!CHROMIUM_EXE_NAMES.has(exeName)) return null;
  return { kind: inferKindFromExeName(exeName), path: exePath };
}

// ── Resolve Executable ──

export function resolveBrowserExecutable(opts?: { executablePath?: string }): ChromeExecutable | null {
  if (opts?.executablePath !== undefined && opts.executablePath !== '') {
    if (!fileExists(opts.executablePath)) throw new Error(`executablePath not found: ${opts.executablePath}`);
    return { kind: 'custom', path: opts.executablePath };
  }
  const platform = process.platform;
  if (platform === 'darwin') return detectDefaultChromiumMac() ?? findChromeMac();
  if (platform === 'linux') return detectDefaultChromiumLinux() ?? findChromeLinux();
  if (platform === 'win32') return detectDefaultChromiumWindows() ?? findChromeWindows();
  return null;
}

// ── Port Check ──

async function ensurePortAvailable(port: number, retries = 2): Promise<void> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const tester = net
          .createServer()
          .once('error', (err: NodeJS.ErrnoException) => {
            // Close the server to release its handle on non-EADDRINUSE errors
            tester.close(() => {
              if (err.code === 'EADDRINUSE') reject(new Error(`Port ${String(port)} is already in use`));
              else reject(err);
            });
          })
          .once('listening', () => {
            tester.close(() => {
              resolve();
            });
          })
          .listen(port);
      });
      return;
    } catch (err) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      throw err;
    }
  }
}

// ── Profile Decoration ──

function safeReadJson(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function safeWriteJson(filePath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function setDeep(obj: Record<string, unknown>, keys: string[], value: unknown): void {
  let node: Record<string, unknown> = obj;
  for (const key of keys.slice(0, -1)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
    const next = node[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) node[key] = {};
    // nosemgrep: prototype-pollution-loop -- guarded above
    node = node[key] as Record<string, unknown>;
  }
  const lastKey = keys[keys.length - 1];
  if (lastKey === '__proto__' || lastKey === 'constructor' || lastKey === 'prototype') return;
  node[lastKey] = value;
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

// ── WebSocket / CDP URL Helpers ──

function isWebSocketUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
  } catch {
    return false;
  }
}

export function isDirectCdpWebSocketEndpoint(url: string): boolean {
  if (!isWebSocketUrl(url)) return false;
  try {
    const parsed = new URL(url);
    return /\/devtools\/(?:browser|page|worker|shared_worker|service_worker)\/[^/]/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/\.+$/, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];

export function hasProxyEnvConfigured(env: Record<string, string | undefined> = process.env): boolean {
  for (const key of PROXY_ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value.trim().length > 0) return true;
  }
  return false;
}

/**
 * Normalize a WebSocket debugger URL returned by `/json/version` to match the
 * external CDP host/port. Handles wildcard binds (`0.0.0.0`, `[::]`),
 * protocol upgrades (HTTP→WSS), and auth/search param inheritance.
 */
export function normalizeCdpWsUrl(wsUrl: string, cdpUrl: string): string {
  const ws = new URL(wsUrl);
  const cdp = new URL(cdpUrl);
  const isWildcardBind = ws.hostname === '0.0.0.0' || ws.hostname === '[::]';
  if ((isLoopbackHost(ws.hostname) || isWildcardBind) && !isLoopbackHost(cdp.hostname)) {
    ws.hostname = cdp.hostname;
    const cdpPort = cdp.port || (cdp.protocol === 'https:' ? '443' : '80');
    if (cdpPort) ws.port = cdpPort;
    ws.protocol = cdp.protocol === 'https:' ? 'wss:' : 'ws:';
  } else if (isLoopbackHost(ws.hostname) && isLoopbackHost(cdp.hostname)) {
    ws.hostname = cdp.hostname;
  }
  if (cdp.protocol === 'https:' && ws.protocol === 'ws:') ws.protocol = 'wss:';
  if (!ws.username && !ws.password && (cdp.username || cdp.password)) {
    ws.username = cdp.username;
    ws.password = cdp.password;
  }
  for (const [key, value] of cdp.searchParams.entries()) {
    if (!ws.searchParams.has(key)) ws.searchParams.append(key, value);
  }
  return ws.toString();
}

/**
 * Convert a WebSocket CDP URL to an HTTP base URL for `/json/*` endpoints.
 */
export function normalizeCdpHttpBaseForJsonEndpoints(cdpUrl: string): string {
  try {
    const url = new URL(cdpUrl);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol === 'wss:') url.protocol = 'https:';
    url.pathname = url.pathname.replace(/\/devtools\/browser\/.*$/, '');
    url.pathname = url.pathname.replace(/\/cdp$/, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    let normalized = cdpUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
    const dtIdx = normalized.indexOf('/devtools/browser/');
    if (dtIdx >= 0) normalized = normalized.slice(0, dtIdx);
    return normalized.replace(/\/cdp$/, '').replace(/\/$/, '');
  }
}

function appendCdpPath(cdpUrl: string, cdpPath: string): string {
  const url = new URL(cdpUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}${cdpPath.startsWith('/') ? cdpPath : `/${cdpPath}`}`;
  return url.toString();
}

// ── Chrome Reachability ──

async function canOpenWebSocket(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(
      () => {
        finish(false);
      },
      Math.max(1, timeoutMs + Math.min(25, timeoutMs)),
    );
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      finish(false);
      return;
    }
    ws.onopen = () => {
      finish(true);
    };
    ws.onerror = () => {
      finish(false);
    };
  });
}

async function fetchChromeVersion(
  cdpUrl: string,
  timeoutMs = 500,
  authToken?: string,
  ssrfPolicy?: SsrfPolicy,
): Promise<Record<string, unknown> | null> {
  try {
    await assertCdpEndpointAllowed(cdpUrl, ssrfPolicy);
  } catch {
    return null;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => {
    ctrl.abort();
  }, timeoutMs);
  try {
    const httpBase = isWebSocketUrl(cdpUrl) ? normalizeCdpHttpBaseForJsonEndpoints(cdpUrl) : cdpUrl;
    const headers: Record<string, string> = {};
    if (authToken !== undefined && authToken !== '') headers.Authorization = `Bearer ${authToken}`;
    const res = await fetch(appendCdpPath(httpBase, '/json/version'), { signal: ctrl.signal, headers });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (data === null || data === undefined || typeof data !== 'object') return null;
    return data as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const COMMON_CDP_PORTS = [9222, 9223, 9224, 9225, 9226, 9229];

export async function discoverChromeCdpUrl(timeoutMs = 500): Promise<string | null> {
  const results = await Promise.all(
    COMMON_CDP_PORTS.map(async (port) => {
      const url = `http://127.0.0.1:${String(port)}`;
      return (await isChromeReachable(url, timeoutMs)) ? url : null;
    }),
  );
  return results.find((url) => url !== null) ?? null;
}

export async function isChromeReachable(
  cdpUrl: string,
  timeoutMs = 500,
  authToken?: string,
  ssrfPolicy?: SsrfPolicy,
): Promise<boolean> {
  try {
    await assertCdpEndpointAllowed(cdpUrl, ssrfPolicy);
  } catch {
    return false;
  }
  if (isDirectCdpWebSocketEndpoint(cdpUrl)) return await canOpenWebSocket(cdpUrl, timeoutMs);
  const discoveryUrl = isWebSocketUrl(cdpUrl) ? normalizeCdpHttpBaseForJsonEndpoints(cdpUrl) : cdpUrl;
  const version = await fetchChromeVersion(discoveryUrl, timeoutMs, authToken, ssrfPolicy);
  if (version !== null) return true;
  if (isWebSocketUrl(cdpUrl)) return await canOpenWebSocket(cdpUrl, timeoutMs);
  return false;
}

export async function getChromeWebSocketUrl(
  cdpUrl: string,
  timeoutMs = 500,
  authToken?: string,
  ssrfPolicy?: SsrfPolicy,
): Promise<string | null> {
  await assertCdpEndpointAllowed(cdpUrl, ssrfPolicy);
  if (isDirectCdpWebSocketEndpoint(cdpUrl)) return cdpUrl;
  const discoveryUrl = isWebSocketUrl(cdpUrl) ? normalizeCdpHttpBaseForJsonEndpoints(cdpUrl) : cdpUrl;
  const version = await fetchChromeVersion(discoveryUrl, timeoutMs, authToken, ssrfPolicy);
  const rawWsUrl = version?.webSocketDebuggerUrl;
  const wsUrl = typeof rawWsUrl === 'string' ? rawWsUrl.trim() : '';
  if (wsUrl === '') {
    if (isWebSocketUrl(cdpUrl)) return cdpUrl;
    return null;
  }
  const normalized = normalizeCdpWsUrl(wsUrl, discoveryUrl);
  await assertCdpEndpointAllowed(normalized, ssrfPolicy);
  return normalized;
}

export async function isChromeCdpReady(
  cdpUrl: string,
  timeoutMs = 500,
  handshakeTimeoutMs = 800,
  ssrfPolicy?: SsrfPolicy,
): Promise<boolean> {
  const wsUrl = await getChromeWebSocketUrl(cdpUrl, timeoutMs, undefined, ssrfPolicy).catch(() => null);
  if (wsUrl === null) return false;
  return await canRunCdpHealthCommand(wsUrl, handshakeTimeoutMs);
}

async function canRunCdpHealthCommand(wsUrl: string, timeoutMs = 800): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(value);
    };

    const timer = setTimeout(
      () => {
        finish(false);
      },
      Math.max(1, timeoutMs + Math.min(25, timeoutMs)),
    );

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      finish(false);
      return;
    }

    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
      } catch {
        finish(false);
      }
    };
    ws.onmessage = (event) => {
      try {
        const parsed: unknown = JSON.parse(String(event.data));
        if (typeof parsed !== 'object' || parsed === null) return;
        const msg = parsed as Record<string, unknown>;
        if (msg.id !== 1) return;
        finish(typeof msg.result === 'object' && msg.result !== null);
      } catch {
        /* ignore non-JSON frames */
      }
    };
    ws.onerror = () => {
      finish(false);
    };
    ws.onclose = () => {
      finish(false);
    };
  });
}

export async function launchChrome(opts: LaunchOptions = {}): Promise<RunningChrome> {
  const cdpPort = opts.cdpPort ?? DEFAULT_CDP_PORT;
  await ensurePortAvailable(cdpPort);

  const exe = resolveBrowserExecutable({ executablePath: opts.executablePath });
  if (!exe)
    throw new Error('No supported browser found (Chrome/Brave/Edge/Chromium). Install one or provide executablePath.');

  const profileName = opts.profileName ?? DEFAULT_PROFILE_NAME;
  const userDataDir = opts.userDataDir ?? resolveUserDataDir(profileName);
  fs.mkdirSync(userDataDir, { recursive: true });

  const spawnChrome = (spawnOpts?: { detached?: boolean }, runOpts?: { forceHeadless?: boolean }) => {
    const args = [
      `--remote-debugging-port=${String(cdpPort)}`,
      '--remote-debugging-address=127.0.0.1',
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
    if (opts.headless === true || runOpts?.forceHeadless === true) {
      args.push('--headless=new', '--disable-gpu');
    }
    if (opts.noSandbox === true) {
      args.push('--no-sandbox', '--disable-setuid-sandbox');
    }
    if (opts.ignoreHTTPSErrors === true) {
      args.push('--ignore-certificate-errors');
    }
    if (process.platform === 'linux') args.push('--disable-dev-shm-usage');
    const extraArgs = Array.isArray(opts.chromeArgs)
      ? opts.chromeArgs.filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
      : [];
    if (extraArgs.length) args.push(...extraArgs);
    args.push('about:blank');
    return spawn(exe.path, args, {
      stdio: 'pipe',
      env: { ...process.env, HOME: os.homedir() },
      ...spawnOpts,
    });
  };

  const startedAt = Date.now();
  const localStatePath = path.join(userDataDir, 'Local State');
  const preferencesPath = path.join(userDataDir, 'Default', 'Preferences');

  if (!fileExists(localStatePath) || !fileExists(preferencesPath)) {
    const useDetached = process.platform !== 'win32';
    const bootstrap = spawnChrome(useDetached ? { detached: true } : undefined, { forceHeadless: true });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (fileExists(localStatePath) && fileExists(preferencesPath)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    killProcessTree(bootstrap, 'SIGTERM');
    const exitDeadline = Date.now() + 5000;
    while (Date.now() < exitDeadline) {
      if (bootstrap.exitCode != null) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (bootstrap.exitCode == null) {
      killProcessTree(bootstrap, 'SIGKILL');
    }
  }

  try {
    decorateProfile(userDataDir, profileName, opts.profileColor ?? DEFAULT_PROFILE_COLOR);
  } catch {}

  try {
    ensureCleanExit(userDataDir);
  } catch {}

  const proc = spawnChrome();
  const cdpUrl = `http://127.0.0.1:${String(cdpPort)}`;

  // Capture stderr for diagnostics on failure
  const stderrChunks: Buffer[] = [];
  const onStderr = (chunk: Buffer) => {
    stderrChunks.push(chunk);
  };
  proc.stderr.on('data', onStderr);

  const readyDeadline = Date.now() + 15000;
  let pollDelay = 200;
  while (Date.now() < readyDeadline) {
    if (await isChromeCdpReady(cdpUrl, 500)) break;
    await new Promise((r) => setTimeout(r, pollDelay));
    // Back off polling to reduce CPU churn on slow launches
    pollDelay = Math.min(pollDelay + 100, 1000);
  }

  if (!(await isChromeCdpReady(cdpUrl, 500))) {
    const stderrOutput = Buffer.concat(stderrChunks).toString('utf8').trim();
    const stderrHint = stderrOutput ? `\nChrome stderr:\n${stderrOutput.slice(0, 2000)}` : '';
    const sandboxHint =
      process.platform === 'linux' && opts.noSandbox !== true
        ? '\nHint: If running in a container or as root, try setting noSandbox: true.'
        : '';
    try {
      proc.kill('SIGKILL');
    } catch {}
    // Clean up userDataDir lock files on launch failure so subsequent retries don't stall
    try {
      const lockFile = path.join(userDataDir, 'SingletonLock');
      if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
    } catch {}
    throw new Error(`Failed to start Chrome CDP on port ${String(cdpPort)}.${sandboxHint}${stderrHint}`);
  }

  proc.stderr.off('data', onStderr);
  proc.stderr.resume(); // drain to prevent backpressure after removing the listener
  stderrChunks.length = 0;

  return {
    pid: proc.pid ?? -1,
    exe,
    userDataDir,
    cdpPort,
    startedAt,
    launchMs: Date.now() - startedAt,
    proc,
  };
}

export async function stopChrome(running: RunningChrome, timeoutMs = 2500): Promise<void> {
  const proc = running.proc;
  if (proc.exitCode !== null) return;
  killProcessTree(proc, 'SIGTERM');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // exitCode changes asynchronously after SIGTERM; re-read from proc
    if ((proc as { exitCode: number | null }).exitCode !== null) return;
    const remainingMs = timeoutMs - (Date.now() - start);
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(100, remainingMs))));
  }
  killProcessTree(proc, 'SIGKILL');
}
