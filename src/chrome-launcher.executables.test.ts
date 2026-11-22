import type * as ChildProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  execFileSync: execMock,
}));

import { resolveBrowserExecutable } from './chrome-launcher.js';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
if (originalPlatform === undefined) throw new Error('process.platform descriptor missing');
const files = new Set<string>();
const directories = new Set<string>();
const denied = new Set<string>();

function platform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value });
}

const originalArch = Object.getOwnPropertyDescriptor(process, 'arch');
if (originalArch === undefined) throw new Error('process.arch descriptor missing');

function arch(value: NodeJS.Architecture): void {
  Object.defineProperty(process, 'arch', { configurable: true, value });
}

function registry(command: string): void {
  execMock.mockImplementation((_command: string, args: string[]) =>
    args.includes('ProgId') ? 'ProgId REG_SZ OperaStable' : `REG_SZ ${command}`,
  );
}

beforeEach(() => {
  files.clear();
  directories.clear();
  denied.clear();
  execMock.mockReset().mockImplementation(() => {
    throw new Error('not installed');
  });
  vi.spyOn(os, 'homedir').mockReturnValue('/home/test');
  vi.spyOn(fs, 'existsSync').mockImplementation((file) => files.has(String(file)) || directories.has(String(file)));
  vi.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike) => {
    if (!files.has(String(file)) && !directories.has(String(file))) throw new Error('ENOENT');
    return { isFile: () => files.has(String(file)) };
  }) as typeof fs.statSync);
  vi.spyOn(fs, 'accessSync').mockImplementation((file) => {
    if (denied.has(String(file))) throw new Error('EACCES');
  });
  vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
    throw new Error('ENOENT');
  });
  vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
    throw new Error('ENOENT');
  });
  for (const name of [
    'LOCALAPPDATA',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'XDG_CACHE_HOME',
    'INIT_CWD',
    'npm_config_init_cwd',
    'npm_package_config_init_cwd',
  ]) {
    vi.stubEnv(name, '');
  }
  for (const name of [
    'PLAYWRIGHT_BROWSERS_PATH',
    'npm_config_playwright_browsers_path',
    'npm_package_config_playwright_browsers_path',
  ])
    vi.stubEnv(name, undefined);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  Object.defineProperty(process, 'arch', originalArch);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('regular executable discovery', () => {
  it('ignores empty macOS roles without losing a valid viewer or earlier handler', () => {
    platform('darwin');
    files.add('/home/test/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist');
    files.add('/Applications/Vivaldi.app/Contents/MacOS/Vivaldi');
    execMock.mockImplementation((command: string) =>
      command.endsWith('plutil')
        ? JSON.stringify([
            { LSHandlerURLScheme: 'http', LSHandlerRoleAll: '', LSHandlerRoleViewer: 'com.vivaldi.Vivaldi' },
            { LSHandlerURLScheme: 'http', LSHandlerRoleAll: '', LSHandlerRoleViewer: '' },
          ])
        : command.endsWith('osascript')
          ? '/Applications/Vivaldi.app/'
          : 'Vivaldi',
    );
    expect(resolveBrowserExecutable()?.path).toBe('/Applications/Vivaldi.app/Contents/MacOS/Vivaldi');
  });

  it.each(['/opt/custom/google-chrome%U', 'google-chrome%U'])('cleans desktop field codes in %s', (command) => {
    platform('linux');
    files.add('/home/test/.local/share/applications/google-chrome.desktop');
    files.add('/opt/custom/google-chrome');
    vi.mocked(fs.readFileSync).mockReturnValue(`Exec=${command}`);
    execMock.mockImplementation((probe: string, args: string[]) => {
      if (probe !== 'which') return 'google-chrome.desktop';
      return args[0] === 'google-chrome' ? '/opt/custom/google-chrome' : '';
    });
    expect(resolveBrowserExecutable()).toEqual({ kind: 'chrome', path: '/opt/custom/google-chrome' });
    vi.mocked(fs.readFileSync).mockReturnValue('Exec=%U');
    expect(resolveBrowserExecutable()).toBeNull();
  });
  it.each(['linux', 'darwin'] as const)('skips directories and non-executable files on %s', (host) => {
    platform(host);
    const candidates =
      host === 'linux'
        ? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chrome']
        : [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/home/test/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
          ];
    directories.add(candidates[0]);
    files.add(candidates[1]);
    denied.add(candidates[1]);
    files.add(candidates[2]);
    expect(resolveBrowserExecutable()?.path).toBe(candidates[2]);
    expect(fs.accessSync).toHaveBeenCalledWith(candidates[2], fs.constants.X_OK);
  });

  it('validates the Linux default desktop executable before selecting it', () => {
    platform('linux');
    execMock.mockReturnValue('google-chrome.desktop');
    files.add('/home/test/.local/share/applications/google-chrome.desktop');
    vi.mocked(fs.readFileSync).mockReturnValue('Exec=/opt/custom/google-chrome %U');
    files.add('/opt/custom/google-chrome');
    denied.add('/opt/custom/google-chrome');
    expect(resolveBrowserExecutable()).toBeNull();
    denied.clear();
    expect(resolveBrowserExecutable()).toEqual({ kind: 'chrome', path: '/opt/custom/google-chrome' });
  });

  it('validates the macOS default executable before selecting it', () => {
    platform('darwin');
    files.add('/home/test/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist');
    execMock.mockImplementation((command: string) =>
      command.endsWith('plutil')
        ? '[{"LSHandlerURLScheme":"http","LSHandlerRoleAll":"com.vivaldi.Vivaldi"}]'
        : command.endsWith('osascript')
          ? '/Applications/Vivaldi.app/'
          : 'Vivaldi',
    );
    const executable = '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi';
    files.add(executable);
    denied.add(executable);
    expect(resolveBrowserExecutable()).toBeNull();
    denied.clear();
    expect(resolveBrowserExecutable()).toEqual({ kind: 'chromium', path: executable });
  });

  it('preserves explicit non-Windows custom-path existence semantics', () => {
    platform('linux');
    files.add('/custom/browser');
    denied.add('/custom/browser');
    expect(resolveBrowserExecutable({ executablePath: '/custom/browser' })).toEqual({
      kind: 'custom',
      path: '/custom/browser',
    });
    expect(fs.accessSync).not.toHaveBeenCalled();
    expect(() => resolveBrowserExecutable({ executablePath: '/missing' })).toThrow('not found');
  });
});

describe('Playwright cache fallback', () => {
  it.each([
    ['x64', 'chrome-linux64'],
    ['x64', 'chrome-linux'],
    ['arm64', 'chrome-linux-arm64'],
    ['arm64', 'chrome-linux'],
  ] as const)('discovers the %s layout %s only after fixed candidates', (cpu, layout) => {
    platform('linux');
    arch(cpu);
    vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', ' /custom/cache ');
    vi.mocked(fs.readdirSync).mockReturnValue(['firefox-4', 'chromium-2', 'chromium-1'] as never);
    const browser = `/custom/cache/chromium-1/${layout}/chrome`;
    files.add(browser);
    expect(resolveBrowserExecutable()).toEqual({ kind: 'chromium', path: browser });
    files.add('/snap/bin/chromium');
    expect(resolveBrowserExecutable()?.path).toBe('/snap/bin/chromium');
  });

  it.each([
    ['x64', 'chrome-linux-arm64'],
    ['arm64', 'chrome-linux64'],
  ] as const)('ignores a build for another architecture: %s host, %s', (cpu, layout) => {
    platform('linux');
    arch(cpu);
    vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', '/custom/cache');
    vi.mocked(fs.readdirSync).mockReturnValue(['chromium-1'] as never);
    files.add(`/custom/cache/chromium-1/${layout}/chrome`);
    expect(resolveBrowserExecutable()).toBeNull();
  });

  it('prefers the newest revision, comparing revisions as numbers', () => {
    platform('linux');
    arch('x64');
    vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', '/custom/cache');
    vi.mocked(fs.readdirSync).mockReturnValue(['chromium-1200', 'chromium-999', 'chromium-1243'] as never);
    for (const revision of ['999', '1200', '1243'])
      files.add(`/custom/cache/chromium-${revision}/chrome-linux64/chrome`);
    expect(resolveBrowserExecutable()?.path).toBe('/custom/cache/chromium-1243/chrome-linux64/chrome');
    files.delete('/custom/cache/chromium-1243/chrome-linux64/chrome');
    expect(resolveBrowserExecutable()?.path).toBe('/custom/cache/chromium-1200/chrome-linux64/chrome');
  });

  it.each([
    ['Apple M3 Pro', 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'],
    ['Intel(R) Core(TM) i7', 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'],
    ['Apple M3 Pro', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'],
  ])('falls back to the macOS cache on %s only after installed browsers: %s', (model, layout) => {
    platform('darwin');
    vi.spyOn(os, 'cpus').mockReturnValue([{ model }] as never);
    vi.mocked(fs.readdirSync).mockReturnValue(['chromium-7'] as never);
    const browser = `/home/test/Library/Caches/ms-playwright/chromium-7/${layout}`;
    files.add(browser);
    expect(resolveBrowserExecutable()).toEqual({ kind: 'chromium', path: browser });
    const installed = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    files.add(installed);
    expect(resolveBrowserExecutable()?.path).toBe(installed);
  });

  it.each(['chrome-win64', 'chrome-win'])(
    'falls back to the Windows cache only after installed browsers: %s',
    (layout) => {
      platform('win32');
      vi.mocked(os.homedir).mockReturnValue('C:\\Users\\test');
      vi.stubEnv('LOCALAPPDATA', 'D:\\Local');
      vi.mocked(fs.readdirSync).mockReturnValue(['chromium-7'] as never);
      const browser = `D:\\Local\\ms-playwright\\chromium-7\\${layout}\\chrome.exe`;
      files.add(browser);
      expect(resolveBrowserExecutable()).toEqual({ kind: 'chromium', path: browser });
      const installed = 'D:\\Local\\Google\\Chrome\\Application\\chrome.exe';
      files.add(installed);
      expect(resolveBrowserExecutable()?.path).toBe(installed);
    },
  );

  it('control: an unsupported platform never consults the cache', () => {
    platform('freebsd');
    vi.mocked(fs.readdirSync).mockReturnValue(['chromium-7'] as never);
    files.add('/home/test/.cache/ms-playwright/chromium-7/chrome-linux64/chrome');
    expect(resolveBrowserExecutable()).toBeNull();
    expect(fs.readdirSync).not.toHaveBeenCalled();
  });

  it('uses the home cache when the override is 0, and ignores other browser caches', () => {
    platform('linux');
    arch('x64');
    vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', '0');
    vi.mocked(fs.readdirSync).mockReturnValue(['firefox-1', 'chromium-3'] as never);
    const browser = '/home/test/.cache/ms-playwright/chromium-3/chrome-linux64/chrome';
    files.add(browser);
    expect(resolveBrowserExecutable()?.path).toBe(browser);
    expect(fs.readdirSync).not.toHaveBeenCalledWith('0');
  });

  it.each([
    'PLAYWRIGHT_BROWSERS_PATH',
    'npm_config_playwright_browsers_path',
    'npm_package_config_playwright_browsers_path',
  ])('resolves a relative %s against INIT_CWD', (name) => {
    platform('linux');
    arch('arm64');
    vi.stubEnv(name, 'relative-browsers');
    vi.stubEnv('INIT_CWD', '/project');
    vi.mocked(fs.readdirSync).mockReturnValue(['chromium-3'] as never);
    const browser = '/project/relative-browsers/chromium-3/chrome-linux-arm64/chrome';
    files.add(browser);
    expect(resolveBrowserExecutable()?.path).toBe(browser);
  });

  it('prefers package-local browsers for 0 and honors XDG_CACHE_HOME as fallback', () => {
    platform('linux');
    arch('arm64');
    vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', '0');
    vi.stubEnv('XDG_CACHE_HOME', '/custom-xdg');
    vi.mocked(fs.readdirSync).mockReturnValue(['chromium-3'] as never);
    const localRoot = path.join(
      path.dirname(fileURLToPath(import.meta.resolve('playwright-core/package.json'))),
      '.local-browsers',
    );
    const localBrowser = path.join(localRoot, 'chromium-3/chrome-linux-arm64/chrome');
    const xdgBrowser = '/custom-xdg/ms-playwright/chromium-3/chrome-linux/chrome';
    files.add(localBrowser);
    files.add(xdgBrowser);
    expect(resolveBrowserExecutable()?.path).toBe(localBrowser);
    files.delete(localBrowser);
    expect(resolveBrowserExecutable()?.path).toBe(xdgBrowser);
  });
});

describe('Windows discovery and Opera handoff launchers', () => {
  beforeEach(() => {
    platform('win32');
    vi.mocked(os.homedir).mockReturnValue('C:\\Users\\test');
  });

  it('falls back to the HTTP command when the ProgId command is empty', () => {
    const browser = 'C:\\Browser\\chrome.exe';
    files.add(browser);
    execMock.mockImplementation((_command: string, args: string[]) => {
      if (args.includes('ProgId')) return 'ProgId REG_SZ EmptyBrowser';
      if (args[1] === 'HKCR\\http\\shell\\open\\command') return `REG_SZ "${browser}"`;
      return 'REG_SZ   ';
    });
    expect(resolveBrowserExecutable()?.path).toBe(browser);
    files.clear();
    expect(resolveBrowserExecutable()).toBeNull();
  });

  it('uses trimmed installation roots and the default LocalAppData', () => {
    const localBrowser = 'C:\\Users\\test\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
    files.add(localBrowser);
    expect(resolveBrowserExecutable()?.path).toBe(localBrowser);
    expect(fs.accessSync).toHaveBeenCalledWith(localBrowser, fs.constants.F_OK);
    files.clear();
    vi.stubEnv('ProgramFiles', '  D:\\Programs  ');
    const programBrowser = 'D:\\Programs\\Google\\Chrome\\Application\\chrome.exe';
    files.add(programBrowser);
    expect(resolveBrowserExecutable()?.path).toBe(programBrowser);
  });

  it('expands installation-root variables case-insensitively', () => {
    vi.stubEnv('LOCALAPPDATA', ' D:\\Local ');
    registry('"%localappdata%\\Browser\\chrome.exe" "%1"');
    files.add('D:\\Local\\Browser\\chrome.exe');
    expect(resolveBrowserExecutable()?.path).toBe('D:\\Local\\Browser\\chrome.exe');
  });

  it.each(['wrapper C:\\Browser\\chrome.exe', 'C:\\Browser\\chrome.exe.suffix'])(
    'rejects a non-executable command prefix: %s',
    (command) => {
      registry(command);
      files.add('C:\\Browser\\chrome.exe');
      expect(resolveBrowserExecutable()).toBeNull();
    },
  );

  it('accepts an anchored unquoted registry executable', () => {
    registry('  C:\\Browser\\chrome.exe --flag');
    files.add('C:\\Browser\\chrome.exe');
    expect(resolveBrowserExecutable()?.path).toBe('C:\\Browser\\chrome.exe');
  });

  it('resolves a validated Opera launcher to its direct executable', () => {
    const launcher = 'C:\\Opera\\launcher.exe';
    const direct = 'C:\\Opera\\123.0.1\\opera.exe';
    files.add(launcher);
    files.add(direct);
    vi.mocked(fs.readFileSync).mockReturnValue('{"_subfolder":"123.0.1"}');
    registry(`"${launcher}" "%1"`);
    expect(resolveBrowserExecutable()).toEqual({ kind: 'chromium', path: direct });
    expect(resolveBrowserExecutable({ executablePath: launcher })).toEqual({ kind: 'custom', path: direct });
    expect(fs.readFileSync).toHaveBeenCalledWith(path.win32.join('C:\\Opera', 'installation_status.json'), 'utf8');
  });

  it.each(['../outside', '123', '123.0/../outside', '123.0.1.2.3', ' 123.0 ', ''])(
    'rejects unsafe or invalid Opera status: %s',
    (subfolder) => {
      const launcher = 'C:\\Opera\\launcher.exe';
      files.add(launcher);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ _subfolder: subfolder }));
      registry(`"${launcher}"`);
      expect(resolveBrowserExecutable()).toBeNull();
      expect(() => resolveBrowserExecutable({ executablePath: launcher })).toThrow('handoff launcher');
    },
  );

  it('rejects missing, malformed, or non-file Opera targets', () => {
    const launcher = 'C:\\Opera\\launcher.exe';
    files.add(launcher);
    registry(`"${launcher}"`);
    for (const status of ['{', 'null', '{}', '{"_subfolder":"123.0"}']) {
      vi.mocked(fs.readFileSync).mockReturnValue(status);
      expect(resolveBrowserExecutable()).toBeNull();
    }
    directories.add('C:\\Opera\\123.0\\opera.exe');
    expect(resolveBrowserExecutable()).toBeNull();
  });
});
