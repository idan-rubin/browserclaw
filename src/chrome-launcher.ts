import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';

import type Ws from 'ws';

const execFileAsync = promisify(execFile);

import {
  cdpMessageText,
  closeCdpSocket,
  fetchCdpJson,
  openPinnedCdpSocket,
  sendCdpCommand,
  type CdpEndpoint,
} from './cdp-network.js';
import { readProfileJson, writeProfileJson } from './profile-json.js';
import {
  resolveCdpEndpointPin,
  getHeadersWithAuth,
  scopeCdpPolicyToConfiguredEndpoint,
  stripUrlCredentials,
} from './security.js';
import type { ChromeExecutable, ChromeKind, LaunchOptions, RunningChrome, SsrfPolicy } from './types.js';

// ── Singleton Lock Recovery ──

const CHROME_SINGLETON_LOCK_PATHS = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
// Brand-agnostic: stderr says "Chromium", "Google Chrome", "Microsoft Edge", ... per build; localized (non-English) messages won't match.
export const CHROME_SINGLETON_IN_USE_PATTERN = /profile appears to be in use by another .{1,40} process/i;

export function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  if (process.platform !== 'linux') return true;
  try {
    const status = fs.readFileSync(`/proc/${String(pid)}/status`, 'utf8');
    return !(/^State:\s+(\S)/m.exec(status)?.[1] === 'Z' && /^Threads:[ \t]+1[ \t]*$/m.test(status));
  } catch {
    return true;
  }
}

export function clearChromeSingletonArtifacts(userDataDir: string): void {
  for (const basename of CHROME_SINGLETON_LOCK_PATHS) {
    try {
      fs.rmSync(path.join(userDataDir, basename), { force: true });
    } catch {
      /* best-effort */
    }
  }
}

export function clearStaleChromeSingletonLocks(userDataDir: string, hostname: string = os.hostname()): boolean {
  const lockPath = path.join(userDataDir, 'SingletonLock');
  let target: string;
  try {
    target = fs.readlinkSync(lockPath);
  } catch {
    return false;
  }
  const match = /^(?<lockHost>.+)-(?<pid>\d+)$/.exec(target);
  if (!match?.groups) return false;
  const lockHost = match.groups.lockHost;
  const pid = Number.parseInt(match.groups.pid, 10);
  if (lockHost === hostname && processExists(pid)) return false;
  console.warn(
    `[browserclaw] Removing Chrome Singleton* locks in ${userDataDir} held by "${lockHost}" (pid ${String(pid)})` +
      (lockHost === hostname
        ? ' — process no longer running.'
        : ' — lock is from another host; if this profile is live on another machine or container, that session may be disrupted.'),
  );
  clearChromeSingletonArtifacts(userDataDir);
  return true;
}

function processHasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

async function waitForChromeProcessExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (processHasExited(proc)) return true;
  return await new Promise<boolean>((resolve) => {
    const cleanup = () => {
      clearTimeout(timer);
      proc.off('exit', onExit);
      proc.off('close', onExit);
    };
    const timer = setTimeout(
      () => {
        cleanup();
        resolve(false);
      },
      Math.max(0, timeoutMs),
    );
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    proc.once('exit', onExit);
    proc.once('close', onExit);
    if (processHasExited(proc)) onExit();
  });
}

async function terminateChromeForRetry(proc: ChildProcess, userDataDir: string): Promise<void> {
  if (!(await signalChromeProcess(proc, 'SIGKILL', 5000)))
    throw new Error('Chrome process survived singleton recovery cleanup.');
  clearStaleChromeSingletonLocks(userDataDir);
}

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

async function signalChromeProcess(proc: ChildProcess, signal: NodeJS.Signals, timeoutMs: number): Promise<boolean> {
  if (processHasExited(proc)) return true;
  killProcessTree(proc, signal);
  return await waitForChromeProcessExit(proc, timeoutMs);
}

/** @internal Byte-bounded diagnostics retain recovery markers even after their text is evicted. */
export function createChromeLaunchStderrDiagnostics(maxBytes = 65536) {
  const storage = Buffer.allocUnsafe(Math.max(0, maxBytes));
  let totalBytes = 0;
  let markerScanTail = '';
  let singletonInUse = false;
  return {
    append(chunk: Buffer) {
      const scanText = markerScanTail + chunk.toString('utf8');
      singletonInUse ||= CHROME_SINGLETON_IN_USE_PATTERN.test(scanText);
      markerScanTail = scanText.slice(-256);
      if (chunk.length >= maxBytes) {
        chunk.copy(storage, 0, chunk.length - maxBytes);
        totalBytes = maxBytes;
        return;
      }
      const overflow = Math.max(0, totalBytes + chunk.length - maxBytes);
      if (overflow > 0) {
        storage.copyWithin(0, overflow, totalBytes);
        totalBytes -= overflow;
      }
      chunk.copy(storage, totalBytes);
      totalBytes += chunk.length;
    },
    text(): string {
      let start = 0;
      while (start < totalBytes && (storage[start] & 0xc0) === 0x80) start += 1;
      return new StringDecoder('utf8').write(storage.subarray(start, totalBytes));
    },
    hasSingletonConflict(): boolean {
      return singletonInUse;
    },
    clear() {
      totalBytes = 0;
      markerScanTail = '';
      singletonInUse = false;
    },
  };
}

/** @internal Keep the final diagnostic hint within its UTF-16 budget without splitting a pair. */
export function chromeLaunchStderrHint(stderrOutput: string): string {
  if (!stderrOutput) return '';
  let start = Math.max(0, stderrOutput.length - 2000);
  const first = stderrOutput.charCodeAt(start);
  const previous = stderrOutput.charCodeAt(start - 1);
  if (first >= 0xdc00 && first <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) start += 1;
  return `\nChrome stderr:\n${stderrOutput.slice(start)}`;
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

function isExecutable(filePath: string): boolean {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    fs.accessSync(filePath, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
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
  for (const c of candidates) if (isExecutable(c.path)) return c;
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
        (typeof rec.LSHandlerRoleAll === 'string' && rec.LSHandlerRoleAll) ||
        (typeof rec.LSHandlerRoleViewer === 'string' && rec.LSHandlerRoleViewer) ||
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
  if (!isExecutable(exePath)) return null;
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

  const cleaned = command.trim().replace(/%[a-zA-Z]/g, '');
  if (!cleaned) return null;
  const resolved = cleaned.startsWith('/') ? cleaned : (execText('which', [cleaned], 800)?.trim() ?? null);
  if (resolved === null || resolved === '' || !isExecutable(resolved)) return null;
  const exeName = path.posix.basename(resolved).toLowerCase();
  if (!CHROMIUM_EXE_NAMES.has(exeName)) return null;
  return { kind: inferKindFromExeName(exeName), path: resolved };
}

function findChromeLinux(): ChromeExecutable | null {
  return findFirstExe([
    { kind: 'chrome', path: '/usr/bin/google-chrome' },
    { kind: 'chrome', path: '/usr/bin/google-chrome-stable' },
    { kind: 'chrome', path: '/usr/bin/chrome' },
    { kind: 'chrome', path: '/opt/google/chrome/chrome' },
    { kind: 'brave', path: '/usr/bin/brave-browser' },
    { kind: 'brave', path: '/usr/bin/brave-browser-stable' },
    { kind: 'brave', path: '/usr/bin/brave' },
    { kind: 'brave', path: '/snap/bin/brave' },
    { kind: 'brave', path: '/opt/brave.com/brave/brave-browser' },
    { kind: 'edge', path: '/usr/bin/microsoft-edge' },
    { kind: 'edge', path: '/usr/bin/microsoft-edge-stable' },
    { kind: 'chromium', path: '/usr/bin/chromium' },
    { kind: 'chromium', path: '/usr/bin/chromium-browser' },
    { kind: 'chromium', path: '/snap/bin/chromium' },
    { kind: 'chromium', path: '/usr/lib/chromium/chromium' },
    { kind: 'chromium', path: '/usr/lib/chromium-browser/chromium-browser' },
    ...findPlaywrightChromiumCandidates(),
  ]);
}

function findPlaywrightChromiumCandidates(): ChromeExecutable[] {
  const configured = nonEmptyEnvironmentValue('PLAYWRIGHT_BROWSERS_PATH');
  const cacheDirs = new Set([
    ...(configured !== undefined && configured !== '0' ? [configured] : []),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
  ]);
  const candidates: ChromeExecutable[] = [];
  for (const cacheDir of cacheDirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(cacheDir).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith('chromium-')) continue;
      for (const layout of ['chrome-linux64', 'chrome-linux']) {
        candidates.push({ kind: 'chromium', path: path.join(cacheDir, entry, layout, 'chrome') });
      }
    }
  }
  return candidates;
}

// ── Windows Detection ──

function nonEmptyEnvironmentValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === '' ? undefined : value;
}

function resolveWindowsInstallRoots(): { localAppData: string; programFiles: string; programFilesX86: string } {
  return {
    localAppData: nonEmptyEnvironmentValue('LOCALAPPDATA') ?? path.win32.join(os.homedir(), 'AppData', 'Local'),
    programFiles: nonEmptyEnvironmentValue('ProgramFiles') ?? 'C:\\Program Files',
    programFilesX86: nonEmptyEnvironmentValue('ProgramFiles(x86)') ?? 'C:\\Program Files (x86)',
  };
}

function findChromeWindows(): ChromeExecutable | null {
  const { localAppData, programFiles, programFilesX86 } = resolveWindowsInstallRoots();
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
  const value = /ProgId\s+REG_\w+\s+(.+)$/im.exec(output)?.[1]?.trim();
  return value === undefined || value === '' ? null : value;
}

function readWindowsCommandForProgId(progId: string): string | null {
  const output = execText('reg', [
    'query',
    progId === 'http' ? 'HKCR\\http\\shell\\open\\command' : `HKCR\\${progId}\\shell\\open\\command`,
    '/ve',
  ]);
  if (output === null) return null;
  const value = /REG_\w+\s+(.+)$/im.exec(output)?.[1]?.trim();
  return value === undefined || value === '' ? null : value;
}

function expandWindowsEnvVars(value: string): string {
  const roots = resolveWindowsInstallRoots();
  const installRoots: Partial<Record<string, string>> = {
    localappdata: roots.localAppData,
    programfiles: roots.programFiles,
    'programfiles(x86)': roots.programFilesX86,
  };
  return value.replace(/%([^%]+)%/g, (_match, name: string) => {
    const key = name.trim();
    return key !== '' ? (nonEmptyEnvironmentValue(key) ?? installRoots[key.toLowerCase()] ?? `%${key}%`) : _match;
  });
}

function extractWindowsExecutablePath(command: string): string | null {
  const quoted = /"([^"]+\.exe)"/i.exec(command);
  if (quoted?.[1] !== undefined) return quoted[1];
  const unquoted = /^\s*(\S+\.exe)(?:\s|$)/i.exec(command);
  if (unquoted?.[1] !== undefined) return unquoted[1];
  return null;
}

function resolveDirectWindowsExecutable(executablePath: string): string | null {
  if (path.win32.basename(executablePath).toLowerCase() !== 'launcher.exe') return executablePath;
  const installDir = path.win32.dirname(executablePath);
  try {
    const status: unknown = JSON.parse(
      fs.readFileSync(path.win32.join(installDir, 'installation_status.json'), 'utf8'),
    );
    const subfolder: unknown = status !== null && typeof status === 'object' ? Reflect.get(status, '_subfolder') : null;
    if (typeof subfolder !== 'string' || !/^\d+(?:\.\d+){1,3}$/.test(subfolder)) return null;
    const candidate = path.win32.join(installDir, subfolder, 'opera.exe');
    return isExecutable(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function detectDefaultChromiumWindows(): ChromeExecutable | null {
  const progId = readWindowsProgId();
  const command = (progId !== null ? readWindowsCommandForProgId(progId) : null) ?? readWindowsCommandForProgId('http');
  if (command === null) return null;
  const exePath = extractWindowsExecutablePath(expandWindowsEnvVars(command));
  if (exePath === null) return null;
  if (!isExecutable(exePath)) return null;
  const directPath = resolveDirectWindowsExecutable(exePath);
  if (directPath === null) return null;
  const exeName = path.win32.basename(directPath).toLowerCase();
  if (!CHROMIUM_EXE_NAMES.has(exeName)) return null;
  return { kind: inferKindFromExeName(exeName), path: directPath };
}

// ── Resolve Executable ──

export function resolveBrowserExecutable(opts?: { executablePath?: string }): ChromeExecutable | null {
  if (opts?.executablePath !== undefined && opts.executablePath !== '') {
    if (!fileExists(opts.executablePath)) throw new Error(`executablePath not found: ${opts.executablePath}`);
    const directPath =
      process.platform === 'win32' ? resolveDirectWindowsExecutable(opts.executablePath) : opts.executablePath;
    if (directPath === null) {
      throw new Error(
        `executablePath must point to the browser executable, not a handoff launcher: ${opts.executablePath}`,
      );
    }
    return { kind: 'custom', path: directPath };
  }
  const platform = process.platform;
  if (platform === 'darwin') return detectDefaultChromiumMac() ?? findChromeMac();
  if (platform === 'linux') return detectDefaultChromiumLinux() ?? findChromeLinux();
  if (platform === 'win32') return detectDefaultChromiumWindows() ?? findChromeWindows();
  return null;
}

// ── Port Check ──

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const tester = net
      .createServer()
      .once('error', () => {
        tester.close(() => {
          resolve(false);
        });
      })
      .once('listening', () => {
        tester.close(() => {
          resolve(true);
        });
      })
      .listen(port);
  });
}

async function ensurePortAvailable(port: number, retries = 2): Promise<void> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (await isPortAvailable(port)) return;
    if (attempt < retries) await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Port ${String(port)} is already in use`);
}

export async function reserveFreePortFromList(candidates: readonly number[]): Promise<number> {
  for (const port of candidates) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No free port found among [${candidates.join(', ')}]`);
}

// ── Profile Decoration ──

function safeReadJson(filePath: string): Record<string, unknown> | null {
  return readProfileJson(filePath);
}

function safeWriteJson(filePath: string, data: Record<string, unknown>): void {
  writeProfileJson(filePath, data);
}

function setDeep(obj: Record<string, unknown>, keys: string[], value: unknown): void {
  if (keys.length === 0) return;
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

function readNestedRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const next = (value as Record<string, unknown>)[key];
  if (typeof next !== 'object' || next === null || Array.isArray(next)) return undefined;
  return next as Record<string, unknown>;
}

function readDefaultProfileInfo(localState: Record<string, unknown> | null): Record<string, unknown> | undefined {
  return readNestedRecord(readNestedRecord(localState?.profile, 'info_cache'), 'Default');
}

/** Mock-keychain marker must stay consistent across launches or Chrome cannot decrypt stored cookies. */
function usesBrowserclawMockKeychain(userDataDir: string): boolean {
  return (
    readDefaultProfileInfo(safeReadJson(path.join(userDataDir, 'Local State')))?.browserclaw_mock_keychain === true
  );
}

function parseHexRgbToSignedArgbInt(hex: string): number | null {
  const cleaned = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) return null;
  const argbUnsigned = (255 << 24) | Number.parseInt(cleaned, 16);
  return argbUnsigned > 2147483647 ? argbUnsigned - 4294967296 : argbUnsigned;
}

function decorateProfile(userDataDir: string, name: string, color: string, opts?: { mockKeychain?: boolean }): void {
  const colorInt = parseHexRgbToSignedArgbInt(color);
  const localStatePath = path.join(userDataDir, 'Local State');
  const preferencesPath = path.join(userDataDir, 'Default', 'Preferences');

  const localState = safeReadJson(localStatePath) ?? {};
  if (opts?.mockKeychain === true)
    setDeep(localState, ['profile', 'info_cache', 'Default', 'browserclaw_mock_keychain'], true);
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
  wipeChromeSessionState(userDataDir);
}

function ensureProfileNetworkPredictionDisabled(userDataDir: string): void {
  const preferencesPath = path.join(userDataDir, 'Default', 'Preferences');
  const prefs = safeReadJson(preferencesPath) ?? {};
  setDeep(prefs, ['net', 'network_prediction_options'], 2);
  safeWriteJson(preferencesPath, prefs);
}

const CHROME_SESSION_FILE_PREFIXES = ['Tabs_', 'Session_'];
const CHROME_SESSION_FILE_NAMES = ['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs'];

export function wipeChromeSessionState(userDataDir: string): void {
  const sessionsDir = path.join(userDataDir, 'Default', 'Sessions');
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(
        `[browserclaw] wipeChromeSessionState read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }
  for (const name of entries) {
    const isSessionFile =
      CHROME_SESSION_FILE_NAMES.includes(name) || CHROME_SESSION_FILE_PREFIXES.some((p) => name.startsWith(p));
    if (!isSessionFile) continue;
    try {
      fs.unlinkSync(path.join(sessionsDir, name));
    } catch (err) {
      console.warn(
        `[browserclaw] wipeChromeSessionState unlink ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export async function activateMacOsWindowByPid(pid: number): Promise<void> {
  try {
    await execFileAsync(
      'osascript',
      [
        '-e',
        `tell application "System Events" to set frontmost of (first process whose unix id is ${String(pid)}) to true`,
      ],
      { timeout: 1500 },
    );
  } catch (err) {
    console.warn(`[browserclaw] activateMacOsWindowByPid failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Launch Chrome ──

const COMMON_CDP_PORTS = [9222, 9223, 9224, 9225, 9226, 9229];
const DEFAULT_PROFILE_NAME = 'browserclaw';
const DEFAULT_PROFILE_COLOR = '#FF4500';

function resolveUserDataDir(profileName: string): string {
  const configDir = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(configDir, 'browserclaw', 'profiles', profileName, 'user-data');
}

/**
 * Build a per-run isolated profile name + user-data directory. Isolated
 * profiles live under `isolated/<label>-<suffix>` so they are easy to
 * identify and clean up, and never collide with each other or with the
 * shared default profile.
 *
 * A run-scoped random suffix is always appended — even when the caller
 * passes a label string — so that concurrent launches cannot share the
 * same user-data directory (which would fail on Chrome's SingletonLock).
 *
 * @internal Exported for testing.
 */
export function resolveIsolatedProfile(value: boolean | string): { profileName: string; userDataDir: string } {
  const label =
    typeof value === 'string' && value.trim() !== ''
      ? value
          .trim()
          .replace(/[^A-Za-z0-9_-]/g, '_')
          .slice(0, 32)
      : 'run';
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const namePart = `${label}-${suffix}`;
  const profileName = `browserclaw-${namePart}`;
  const root = os.tmpdir();
  const userDataDir = path.join(root, 'browserclaw', 'isolated', namePart);
  return { profileName, userDataDir };
}

// ── WebSocket / CDP URL Helpers ──

export function isWebSocketUrl(url: string): boolean {
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

function omitChromeProxyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  for (const key of [...PROXY_ENV_KEYS, 'NO_PROXY', 'no_proxy']) Reflect.deleteProperty(childEnv, key);
  return childEnv;
}

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
function hasExplicitPort(rawUrl: string): boolean {
  const authority = rawUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/, 1)[0];
  const host = authority.slice(authority.lastIndexOf('@') + 1);
  return /\]:\d+$/.test(host) || (!host.startsWith('[') && /:\d+$/.test(host));
}

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
    if (!ws.port && !hasExplicitPort(wsUrl) && cdp.port) ws.port = cdp.port;
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

type HeaderedWebSocketCtor = new (url: string, init?: { headers?: Record<string, string> }) => WebSocket;

export function openCdpWebSocket(url: string, headers?: Record<string, string>): WebSocket {
  const Ctor = WebSocket as unknown as HeaderedWebSocketCtor;
  return headers !== undefined && Object.keys(headers).length > 0 ? new Ctor(url, { headers }) : new Ctor(url);
}

async function canOpenWebSocket(
  endpoint: CdpEndpoint,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<boolean> {
  try {
    closeCdpSocket(await openPinnedCdpSocket(endpoint, { timeoutMs, headers }));
    return true;
  } catch {
    return false;
  }
}

/** Cap on CDP `/json/*` response sizes so a hostile endpoint cannot force an unbounded buffer. */
export const CDP_JSON_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

/** Read a fetch Response body as JSON, failing once it exceeds `maxBytes`. */
export async function readJsonResponseBounded(
  res: Response,
  label: string,
  maxBytes: number = CDP_JSON_RESPONSE_MAX_BYTES,
): Promise<unknown> {
  const reader = res.body?.getReader();
  let bytes: Uint8Array;
  if (reader === undefined) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new Error(`${label}: JSON response exceeds ${String(maxBytes)} bytes`);
    bytes = buf;
  } else {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {
          /* noop */
        });
        throw new Error(`${label}: JSON response exceeds ${String(maxBytes)} bytes`);
      }
      chunks.push(value);
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch (cause) {
    throw new Error(`${label}: malformed JSON response`, { cause });
  }
}

async function fetchChromeVersion(
  cdpUrl: string,
  timeoutMs = 500,
  authToken?: string,
  ssrfPolicy?: SsrfPolicy,
  versionPath = '/json/version',
): Promise<Record<string, unknown> | null> {
  try {
    const httpBase = isWebSocketUrl(cdpUrl) ? normalizeCdpHttpBaseForJsonEndpoints(cdpUrl) : cdpUrl;
    const versionUrl = appendCdpPath(httpBase, versionPath);
    const headers: Record<string, string> = getHeadersWithAuth(versionUrl);
    if (authToken !== undefined && authToken !== '' && !headers.Authorization)
      headers.Authorization = `Bearer ${authToken}`;
    const data = await fetchCdpJson(stripUrlCredentials(versionUrl), {
      timeoutMs,
      headers,
      ssrfPolicy,
      configuredUrl: cdpUrl,
    });
    if (data === null || data === undefined || typeof data !== 'object') return null;
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Retry `/json/version/` for credentialed endpoints whose proxy only serves the trailing-slash form. */
async function fetchChromeVersionWithCredentialFallback(
  cdpUrl: string,
  timeoutMs = 500,
  authToken?: string,
  ssrfPolicy?: SsrfPolicy,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  const primary = await fetchChromeVersion(cdpUrl, timeoutMs, authToken, ssrfPolicy);
  const authenticated = stripUrlCredentials(cdpUrl) !== cdpUrl || (authToken !== undefined && authToken !== '');
  if (!authenticated) return primary;
  const primaryWsUrl = typeof primary?.webSocketDebuggerUrl === 'string' ? primary.webSocketDebuggerUrl.trim() : '';
  if (primaryWsUrl !== '') return primary;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return primary;
  const fallback = await fetchChromeVersion(cdpUrl, remaining, authToken, ssrfPolicy, '/json/version/');
  return fallback ?? primary;
}

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
  let endpoint: CdpEndpoint;
  try {
    endpoint = { url: cdpUrl, lookup: (await resolveCdpEndpointPin(cdpUrl, ssrfPolicy))?.lookup };
  } catch {
    return false;
  }
  const probeHeaders = getHeadersWithAuth(cdpUrl);
  if (authToken !== undefined && authToken !== '' && !probeHeaders.Authorization)
    probeHeaders.Authorization = `Bearer ${authToken}`;
  if (isDirectCdpWebSocketEndpoint(cdpUrl)) return await canOpenWebSocket(endpoint, timeoutMs, probeHeaders);
  const cdpControlPolicy = scopeCdpPolicyToConfiguredEndpoint(cdpUrl, ssrfPolicy);
  const discoveryUrl = isWebSocketUrl(cdpUrl) ? normalizeCdpHttpBaseForJsonEndpoints(cdpUrl) : cdpUrl;
  const version = await fetchChromeVersionWithCredentialFallback(discoveryUrl, timeoutMs, authToken, cdpControlPolicy);
  if (version !== null) return true;
  if (isWebSocketUrl(cdpUrl)) return await canOpenWebSocket(endpoint, timeoutMs, probeHeaders);
  return false;
}

export async function getChromeWebSocketUrl(
  cdpUrl: string,
  timeoutMs = 500,
  authToken?: string,
  ssrfPolicy?: SsrfPolicy,
): Promise<string | null> {
  return (await getChromeWebSocketEndpoint(cdpUrl, timeoutMs, authToken, ssrfPolicy))?.url ?? null;
}

/** @internal The lookup must travel with discovery through the final socket dial. */
export async function getChromeWebSocketEndpoint(
  cdpUrl: string,
  timeoutMs = 500,
  authToken?: string,
  ssrfPolicy?: SsrfPolicy,
): Promise<CdpEndpoint | null> {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(
    () => {
      controller.abort();
    },
    Math.max(1, timeoutMs),
  );
  try {
    const configured = await resolveCdpEndpointPin(cdpUrl, ssrfPolicy, undefined, controller.signal);
    if (isDirectCdpWebSocketEndpoint(cdpUrl)) return { url: cdpUrl, lookup: configured?.lookup };
    const cdpControlPolicy = scopeCdpPolicyToConfiguredEndpoint(cdpUrl, ssrfPolicy);
    const discoveryUrl = isWebSocketUrl(cdpUrl) ? normalizeCdpHttpBaseForJsonEndpoints(cdpUrl) : cdpUrl;
    const version = await fetchChromeVersionWithCredentialFallback(
      discoveryUrl,
      Math.max(1, deadline - Date.now()),
      authToken,
      cdpControlPolicy,
    );
    const rawWsUrl = version?.webSocketDebuggerUrl;
    const wsUrl = typeof rawWsUrl === 'string' ? rawWsUrl.trim() : '';
    if (wsUrl === '') {
      if (isWebSocketUrl(cdpUrl)) return { url: cdpUrl, lookup: configured?.lookup };
      return null;
    }
    const normalized = normalizeCdpWsUrl(wsUrl, discoveryUrl);
    const pin = await resolveCdpEndpointPin(
      normalized,
      cdpControlPolicy,
      {
        source: 'discovered',
        configuredUrl: cdpUrl,
      },
      controller.signal,
    );
    return { url: normalized, lookup: pin?.lookup };
  } finally {
    clearTimeout(timer);
  }
}

export async function isChromeCdpReady(
  cdpUrl: string,
  timeoutMs = 500,
  handshakeTimeoutMs = 800,
  ssrfPolicy?: SsrfPolicy,
): Promise<boolean> {
  const endpoint = await getChromeWebSocketEndpoint(cdpUrl, timeoutMs, undefined, ssrfPolicy).catch(() => null);
  if (endpoint === null) return false;
  return await canRunCdpHealthCommand(endpoint, handshakeTimeoutMs);
}

async function canRunCdpHealthCommand(endpoint: CdpEndpoint, timeoutMs = 800): Promise<boolean> {
  let ws: Ws;
  const deadline = Date.now() + timeoutMs;
  try {
    ws = await openPinnedCdpSocket(endpoint, { timeoutMs });
  } catch {
    return false;
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        closeCdpSocket(ws);
      } catch {}
      resolve(value);
    };

    const timer = setTimeout(
      () => {
        finish(false);
      },
      Math.max(1, deadline - Date.now()),
    );

    ws.onmessage = (event) => {
      try {
        const parsed: unknown = JSON.parse(typeof event.data === 'string' ? event.data : cdpMessageText(event.data));
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
    try {
      ws.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
    } catch {
      finish(false);
    }
  });
}

const PROXY_CONTROL_CHROME_ARGS = new Set([
  '--no-proxy-server',
  '--proxy-server',
  '--proxy-pac-url',
  '--proxy-auto-detect',
]);

// Args that route Chrome's traffic through a proxy (excludes --no-proxy-server).
const PROXY_ROUTING_CHROME_ARGS = new Set(['--proxy-server', '--proxy-pac-url', '--proxy-auto-detect']);

function chromeArgName(arg: string): string {
  return arg.trim().split('=', 1)[0]?.toLowerCase() ?? '';
}

function hasChromeProxyControlArg(args: readonly string[]): boolean {
  return args.some((arg) => PROXY_CONTROL_CHROME_ARGS.has(chromeArgName(arg)));
}

function hasChromeProxyRoutingArg(args: readonly string[]): boolean {
  return args.some((arg) => PROXY_ROUTING_CHROME_ARGS.has(chromeArgName(arg)));
}

// CDP URLs whose Chrome was launched proxy-routed — navigation under a strict SSRF
// policy fails closed for these (the proxy egresses, defeating local address checks).
const proxyRoutedCdpUrls = new Set<string>();

function proxyRoutedKey(cdpUrl: string): string {
  let key = cdpUrl.trim();
  while (key.endsWith('/')) key = key.slice(0, -1);
  return key.toLowerCase();
}

export function markCdpUrlProxyRouted(cdpUrl: string): void {
  proxyRoutedCdpUrls.add(proxyRoutedKey(cdpUrl));
}

export function clearCdpUrlProxyRouted(cdpUrl: string): void {
  proxyRoutedCdpUrls.delete(proxyRoutedKey(cdpUrl));
}

export function isCdpUrlProxyRouted(cdpUrl: string): boolean {
  return proxyRoutedCdpUrls.has(proxyRoutedKey(cdpUrl));
}

export interface BuildChromeLaunchArgsOptions {
  cdpPort: number;
  userDataDir: string;
  headless: boolean;
  noSandbox: boolean;
  ignoreHTTPSErrors: boolean;
  ciDefaults: boolean;
  chromeArgs?: string[];
  platform: NodeJS.Platform;
  useMockKeychain?: boolean;
}

export function buildChromeLaunchArgs(opts: BuildChromeLaunchArgsOptions): string[] {
  const args = [
    `--remote-debugging-port=${String(opts.cdpPort)}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${opts.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--password-store=basic',
  ];
  if (opts.ciDefaults) {
    args.push(
      '--disable-sync',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-features=Translate,MediaRouter',
    );
  }
  if (opts.headless) {
    args.push('--headless=new', '--disable-gpu');
  }
  if (opts.noSandbox) {
    args.push('--no-sandbox');
  }
  if (opts.ignoreHTTPSErrors) {
    args.push('--ignore-certificate-errors');
  }
  if (opts.platform === 'darwin' && opts.useMockKeychain === true) args.push('--use-mock-keychain');
  if (opts.platform === 'linux') args.push('--disable-dev-shm-usage');
  const extraArgs = Array.isArray(opts.chromeArgs)
    ? opts.chromeArgs.filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
    : [];
  if (!hasChromeProxyControlArg(extraArgs)) args.push('--no-proxy-server');
  if (extraArgs.length) args.push(...extraArgs);
  args.push('about:blank');
  return args;
}

export async function launchChrome(opts: LaunchOptions = {}): Promise<RunningChrome> {
  let cdpPort: number;
  if (opts.cdpPort !== undefined) {
    await ensurePortAvailable(opts.cdpPort);
    cdpPort = opts.cdpPort;
  } else {
    cdpPort = await reserveFreePortFromList(COMMON_CDP_PORTS);
  }

  const exe = resolveBrowserExecutable({ executablePath: opts.executablePath });
  if (!exe)
    throw new Error('No supported browser found (Chrome/Brave/Edge/Chromium). Install one or provide executablePath.');

  const isolated = opts.isolated;
  const isolatedResolved = isolated === undefined || isolated === false ? null : resolveIsolatedProfile(isolated);
  const profileName = isolatedResolved?.profileName ?? opts.profileName ?? DEFAULT_PROFILE_NAME;
  const userDataDir = isolatedResolved?.userDataDir ?? opts.userDataDir ?? resolveUserDataDir(profileName);
  fs.mkdirSync(userDataDir, { recursive: true });

  const localStatePath = path.join(userDataDir, 'Local State');
  const preferencesPath = path.join(userDataDir, 'Default', 'Preferences');
  const profileIsNew = !fileExists(localStatePath);
  const needsBootstrap = profileIsNew || !fileExists(preferencesPath);
  const useMockKeychain =
    process.platform === 'darwin' &&
    (usesBrowserclawMockKeychain(userDataDir) || (profileIsNew && opts.headless === true));

  const spawnChrome = async (spawnOpts?: { detached?: boolean }, runOpts?: { forceHeadless?: boolean }) => {
    const args = buildChromeLaunchArgs({
      cdpPort,
      userDataDir,
      headless: opts.headless === true || runOpts?.forceHeadless === true,
      noSandbox: opts.noSandbox === true,
      ignoreHTTPSErrors: opts.ignoreHTTPSErrors === true,
      ciDefaults: opts.ciDefaults === true,
      chromeArgs: opts.chromeArgs,
      platform: process.platform,
      useMockKeychain,
    });
    const proc = spawn(exe.path, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...omitChromeProxyEnv(process.env), HOME: os.homedir() },
      ...spawnOpts,
    });
    // Keep a listener for the child's whole lifetime: later process errors must
    // not become unhandled EventEmitter errors in the embedding application.
    proc.on('error', (error) => {
      if (process.env.DEBUG !== undefined && process.env.DEBUG !== '')
        console.warn(`[browserclaw] Chrome process error: ${error.message}`);
    });
    if (proc.pid === undefined) await once(proc, 'spawn');
    if (proc.pid === undefined) throw new Error('Chrome process spawned without a pid.');
    return proc;
  };

  const startedAt = Date.now();

  if (needsBootstrap) {
    const useDetached = process.platform !== 'win32';
    const bootstrap = await spawnChrome(useDetached ? { detached: true } : undefined, { forceHeadless: true });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (fileExists(localStatePath) && fileExists(preferencesPath)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (
      !(await signalChromeProcess(bootstrap, 'SIGTERM', 5000)) &&
      !(await signalChromeProcess(bootstrap, 'SIGKILL', 5000))
    )
      throw new Error('Chrome bootstrap process survived cleanup.');
  }

  try {
    decorateProfile(userDataDir, profileName, opts.profileColor ?? DEFAULT_PROFILE_COLOR, {
      mockKeychain: useMockKeychain,
    });
  } catch {}

  try {
    ensureProfileNetworkPredictionDisabled(userDataDir);
  } catch {}

  try {
    ensureCleanExit(userDataDir);
  } catch {}

  const cdpUrl = `http://127.0.0.1:${String(cdpPort)}`;

  const extraArgsForProxyCheck = Array.isArray(opts.chromeArgs)
    ? opts.chromeArgs.filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
    : [];
  if (hasChromeProxyRoutingArg(extraArgsForProxyCheck)) markCdpUrlProxyRouted(cdpUrl);
  else clearCdpUrlProxyRouted(cdpUrl);

  const launchOnceAndWait = async (
    allowSingletonRecovery: boolean,
  ): Promise<{ proc: Awaited<ReturnType<typeof spawnChrome>> }> => {
    const proc = await spawnChrome();
    const stderrDiagnostics = createChromeLaunchStderrDiagnostics();
    const onStderr = (chunk: Buffer) => {
      stderrDiagnostics.append(chunk);
    };
    proc.stderr.on('data', onStderr);

    const readyDeadline = Date.now() + 15000;
    let pollDelay = 200;
    while (Date.now() < readyDeadline) {
      if (await isChromeCdpReady(cdpUrl, 500)) break;
      await new Promise((r) => setTimeout(r, pollDelay));
      pollDelay = Math.min(pollDelay + 100, 1000);
    }

    if (!(await isChromeCdpReady(cdpUrl, 500))) {
      const stderrOutput = stderrDiagnostics.text().trim();
      if (
        allowSingletonRecovery &&
        stderrDiagnostics.hasSingletonConflict() &&
        clearStaleChromeSingletonLocks(userDataDir)
      ) {
        proc.stderr.off('data', onStderr);
        await terminateChromeForRetry(proc, userDataDir);
        return await launchOnceAndWait(false);
      }
      const stderrHint = chromeLaunchStderrHint(stderrOutput);
      const sandboxHint =
        process.platform === 'linux' && opts.noSandbox !== true
          ? '\nHint: If running in a container or as root, try setting noSandbox: true.'
          : '';
      proc.stderr.off('data', onStderr);
      stderrDiagnostics.clear();
      if (!(await signalChromeProcess(proc, 'SIGKILL', 5000)))
        throw new Error('Chrome process survived launch cleanup.');
      try {
        const lockFile = path.join(userDataDir, 'SingletonLock');
        if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
      } catch {}
      throw new Error(`Failed to start Chrome CDP on port ${String(cdpPort)}.${sandboxHint}${stderrHint}`);
    }

    proc.stderr.off('data', onStderr);
    proc.stderr.resume();
    stderrDiagnostics.clear();
    return { proc };
  };

  const { proc } = await launchOnceAndWait(true);

  return {
    pid: proc.pid ?? -1,
    exe,
    userDataDir,
    cdpPort,
    startedAt,
    launchMs: Date.now() - startedAt,
    proc,
    ...(isolatedResolved !== null ? { isolated: true } : {}),
  };
}

const CHROME_GRACEFUL_CLOSE_COMMAND_TIMEOUT_MS = 500;

/** CDP `Browser.close` flushes profile data (cookies) before any signal reaches the process group. */
async function requestGracefulChromeClose(running: RunningChrome, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(1, Math.min(timeoutMs, CHROME_GRACEFUL_CLOSE_COMMAND_TIMEOUT_MS));
  const remaining = () => Math.max(1, deadline - Date.now());
  let socket: Ws | undefined;
  try {
    const endpoint = await getChromeWebSocketEndpoint(
      `http://127.0.0.1:${String(running.cdpPort)}`,
      Math.min(remaining(), 200),
    );
    if (endpoint === null || Date.now() >= deadline) return false;
    socket = await openPinnedCdpSocket(endpoint, { timeoutMs: remaining() });
    const result = await sendCdpCommand(socket, 'SystemInfo.getProcessInfo', undefined, undefined, remaining());
    const processes = result.processInfo as { type?: string; id?: number }[] | undefined;
    const browserPid = processes?.find(
      (entry) => entry.type === 'browser' && Number.isSafeInteger(entry.id) && (entry.id ?? 0) > 0,
    )?.id;
    // A recycled debugging port must never close a different browser process.
    if (browserPid !== running.pid || processHasExited(running.proc) || Date.now() >= deadline) return false;
    socket.send(JSON.stringify({ id: 0, method: 'Browser.close' }));
    return true;
  } catch {
    return false;
  } finally {
    if (socket) closeCdpSocket(socket);
  }
}

export async function stopChrome(running: RunningChrome, timeoutMs = 2500): Promise<void> {
  const proc = running.proc;
  clearCdpUrlProxyRouted(`http://127.0.0.1:${String(running.cdpPort)}`);
  const cleanupIsolated = () => {
    if (running.isolated !== true) return;
    try {
      fs.rmSync(running.userDataDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup of isolated profile directory */
    }
  };
  if (processHasExited(proc)) {
    cleanupIsolated();
    return;
  }
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(0, deadline - Date.now());
  const gracefulDeadline = Date.now() + Math.floor(timeoutMs / 2);
  const gracefulRemaining = () => Math.max(0, gracefulDeadline - Date.now());
  if (
    (await requestGracefulChromeClose(running, gracefulRemaining())) &&
    (await waitForChromeProcessExit(proc, gracefulRemaining()))
  ) {
    cleanupIsolated();
    return;
  }
  // Reserve part of the same deadline for confirming SIGKILL; never delete a
  // profile while a surviving child might still be writing to it.
  if (
    !(await signalChromeProcess(proc, 'SIGTERM', Math.floor(remaining() * 0.8))) &&
    !(await signalChromeProcess(proc, 'SIGKILL', remaining()))
  ) {
    throw new Error(`Chrome process ${String(running.pid)} survived shutdown; its profile was preserved.`);
  }
  cleanupIsolated();
}
