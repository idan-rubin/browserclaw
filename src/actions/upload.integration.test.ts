import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type * as Connection from '../connection.js';
import { storeRoleRefsForTarget } from '../ref-resolver.js';
import { DEFAULT_UPLOAD_DIR } from '../security.js';

const mocks = vi.hoisted(() => ({ page: vi.fn<() => Promise<Page>>() }));
vi.mock('../connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Connection>()),
  getPageForTargetId: mocks.page,
  getRestoredPageForTarget: mocks.page,
}));
import { setInputFilesViaPlaywright, uploadViaPlaywright } from './interaction.js';

const executablePath = [chromium.executablePath(), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(
  existsSync,
);
describe.skipIf(executablePath === undefined)('upload payloads (real Chromium)', () => {
  let browser: Browser;
  let page: Page;
  let directory: string;
  let path: string;
  beforeAll(async () => {
    await mkdir(DEFAULT_UPLOAD_DIR, { recursive: true });
    directory = await realpath(await mkdtemp(join(DEFAULT_UPLOAD_DIR, 'native-upload-')));
    path = join(directory, 'report.txt');
    await writeFile(path, 'remote payload bytes');
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage();
    mocks.page.mockResolvedValue(page);
  });
  afterAll(async () => {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('uploads byte payloads atomically and preserves basename, MIME, and events', async () => {
    await page.setContent(
      '<input id="file" type="file" onchange="this.dataset.changed=\'yes\'"><button onclick="document.querySelector(\'#file\').click()">Upload</button>',
    );
    storeRoleRefsForTarget({ page, cdpUrl: 'test', refs: { e1: { role: 'button', name: 'Upload' } }, mode: 'role' });
    await uploadViaPlaywright({ cdpUrl: 'test', ref: 'e1', paths: [path], browserFilesystemLocal: false });
    const file = await page.locator('#file').evaluate(async (input: HTMLInputElement) => {
      const uploaded = input.files?.[0];
      return uploaded
        ? {
            name: uploaded.name,
            mime: uploaded.type,
            text: await uploaded.text(),
            changed: input.dataset.changed,
          }
        : null;
    });
    expect(file).toEqual({
      name: 'report.txt',
      mime: 'text/plain',
      text: 'remote payload bytes',
      changed: 'yes',
    });
  });

  it('keeps direct local-path uploads working without the remote option', async () => {
    await page.setContent('<input id="file" type="file">');
    await setInputFilesViaPlaywright({ cdpUrl: 'test', element: '#file', paths: [path] });
    expect(await page.locator('#file').evaluate((input: HTMLInputElement) => input.files?.[0]?.name)).toBe(
      'report.txt',
    );
  });
});
