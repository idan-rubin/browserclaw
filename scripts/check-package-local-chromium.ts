/** Run after npm run build: exercise package-local discovery in both shipped formats. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const packageRoot = path.dirname(createRequire(import.meta.url).resolve('playwright-core/package.json'));
const callerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'browserclaw-package-discovery-'));

// These are the actual shipped entry points, not a source-module import. Only
// OS discovery and process creation are replaced; module resolution is real.
const probe = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';

const [entry, packageRoot, mode] = process.argv.slice(1);
const library = entry.endsWith('.cjs')
  ? createRequire(pathToFileURL(entry))(entry)
  : await import(pathToFileURL(entry).href);
const localCache = path.join(packageRoot, '.local-browsers');
const fallbackCache = '/__browserclaw_package_smoke__/xdg/ms-playwright';
const localBrowser = path.join(localCache, 'chromium-999', 'chrome-linux-arm64', 'chrome');
const fallbackBrowser = path.join(fallbackCache, 'chromium-999', 'chrome-linux64', 'chrome');
const expected = mode === 'local' ? localBrowser : fallbackBrowser;
const profile = '/__browserclaw_package_smoke__/profile';
const attempted = [];
Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
process.env.XDG_CACHE_HOME = '/__browserclaw_package_smoke__/xdg';
process.env.INIT_CWD = '/__browserclaw_package_smoke__/unrelated-project';
fs.existsSync = (file) => file === path.join(profile, 'Local State') || file === path.join(profile, 'Default', 'Preferences');
fs.readdirSync = (directory) => directory === localCache || directory === fallbackCache ? ['chromium-999'] : [];
fs.statSync = (file) => {
  if (file !== expected && file !== fallbackBrowser) throw new Error('ENOENT');
  return { isFile: () => true };
};
fs.accessSync = (file) => {
  if (file !== expected && file !== fallbackBrowser) throw new Error('EACCES');
};
fs.mkdirSync = () => undefined;
fs.openSync = () => { throw new Error('Profile writes disabled in package discovery probe'); };
childProcess.execFileSync = () => { throw new Error('No system browser installed'); };
childProcess.spawn = (executable) => {
  attempted.push(executable);
  throw new Error('package-discovery-probe-stopped-before-spawn');
};
net.createServer = () => {
  const callbacks = new Map();
  return {
    once(name, callback) { callbacks.set(name, callback); return this; },
    close(callback) { callback(); },
    listen() { queueMicrotask(() => callbacks.get('listening')()); return this; },
  };
};
syncBuiltinESMExports();
await assert.rejects(library.BrowserClaw.launch({ cdpPort: 12345, userDataDir: profile }), /package-discovery-probe-stopped-before-spawn/);
assert.deepEqual(attempted, [expected]);
process.stdout.write(JSON.stringify({ mode, selected: attempted[0] }));
`;

try {
  for (const format of ['js', 'cjs']) {
    const entry = path.resolve('dist', `index.${format}`);
    assert.ok(fs.existsSync(entry), `Missing ${entry}; run npm run build first.`);
    for (const mode of ['local', 'fallback']) {
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', probe, entry, packageRoot, mode], {
        cwd: callerDirectory,
        encoding: 'utf8',
      });
      const result = JSON.parse(output) as { mode: string; selected: string };
      assert.equal(result.mode, mode);
      console.log(`${format} ${mode}: ${result.selected}`);
    }
  }
  console.log('Built ESM and CJS package-local Chromium discovery passed (4 checks).');
} finally {
  fs.rmdirSync(callerDirectory);
}
