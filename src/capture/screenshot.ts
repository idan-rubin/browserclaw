import {
  getPageForTargetId,
  ensurePageState,
  restoreRoleRefsForTarget,
  refLocator,
} from '../connection.js';
import type { RoleRefs } from '../types.js';

export async function takeScreenshotViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  fullPage?: boolean;
  ref?: string;
  element?: string;
  type?: 'png' | 'jpeg';
}): Promise<{ buffer: Buffer }> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  const type = opts.type ?? 'png';

  if (opts.ref) {
    if (opts.fullPage) throw new Error('fullPage is not supported for element screenshots');
    return { buffer: await refLocator(page, opts.ref).screenshot({ type }) };
  }
  if (opts.element) {
    if (opts.fullPage) throw new Error('fullPage is not supported for element screenshots');
    return { buffer: await page.locator(opts.element).first().screenshot({ type }) };
  }
  return { buffer: await page.screenshot({ type, fullPage: Boolean(opts.fullPage) }) };
}

export async function screenshotWithLabelsViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  refs: RoleRefs;
  maxLabels?: number;
  type?: 'png' | 'jpeg';
}): Promise<{ buffer: Buffer; labels: number; skipped: number }> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });

  const type = opts.type ?? 'png';
  const maxLabels = typeof opts.maxLabels === 'number' && Number.isFinite(opts.maxLabels)
    ? Math.max(1, Math.floor(opts.maxLabels)) : 150;

  const viewport = await page.evaluate(() => ({
    scrollX: window.scrollX || 0,
    scrollY: window.scrollY || 0,
    width: window.innerWidth || 0,
    height: window.innerHeight || 0,
  }));

  const refIds = Object.keys(opts.refs ?? {});
  const boxes: Array<{ ref: string; x: number; y: number; w: number; h: number }> = [];
  let skipped = 0;

  for (const ref of refIds) {
    if (boxes.length >= maxLabels) {
      skipped += 1;
      continue;
    }
    try {
      const box = await refLocator(page, ref).boundingBox();
      if (!box) {
        skipped += 1;
        continue;
      }
      const x0 = box.x;
      const y0 = box.y;
      const x1 = box.x + box.width;
      const y1 = box.y + box.height;
      const vx0 = viewport.scrollX;
      const vy0 = viewport.scrollY;
      const vx1 = viewport.scrollX + viewport.width;
      const vy1 = viewport.scrollY + viewport.height;
      if (x1 < vx0 || x0 > vx1 || y1 < vy0 || y0 > vy1) {
        skipped += 1;
        continue;
      }
      boxes.push({
        ref,
        x: x0 - viewport.scrollX,
        y: y0 - viewport.scrollY,
        w: Math.max(1, box.width),
        h: Math.max(1, box.height),
      });
    } catch {
      skipped += 1;
    }
  }

  try {
    if (boxes.length > 0) {
      await page.evaluate((labels) => {
        document.querySelectorAll('[data-openclaw-labels]').forEach((el) => el.remove());
        const root = document.createElement('div');
        root.setAttribute('data-openclaw-labels', '1');
        root.style.position = 'fixed';
        root.style.left = '0';
        root.style.top = '0';
        root.style.zIndex = '2147483647';
        root.style.pointerEvents = 'none';
        root.style.fontFamily = '"SF Mono","SFMono-Regular",Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace';
        const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
        for (const label of labels) {
          const box = document.createElement('div');
          box.setAttribute('data-openclaw-labels', '1');
          box.style.position = 'absolute';
          box.style.left = `${label.x}px`;
          box.style.top = `${label.y}px`;
          box.style.width = `${label.w}px`;
          box.style.height = `${label.h}px`;
          box.style.border = '2px solid #ffb020';
          box.style.boxSizing = 'border-box';
          const tag = document.createElement('div');
          tag.setAttribute('data-openclaw-labels', '1');
          tag.textContent = label.ref;
          tag.style.position = 'absolute';
          tag.style.left = `${label.x}px`;
          tag.style.top = `${clamp(label.y - 18, 0, 20000)}px`;
          tag.style.background = '#ffb020';
          tag.style.color = '#1a1a1a';
          tag.style.fontSize = '12px';
          tag.style.lineHeight = '14px';
          tag.style.padding = '1px 4px';
          tag.style.borderRadius = '3px';
          tag.style.boxShadow = '0 1px 2px rgba(0,0,0,0.35)';
          tag.style.whiteSpace = 'nowrap';
          root.appendChild(box);
          root.appendChild(tag);
        }
        document.documentElement.appendChild(root);
      }, boxes);
    }
    return {
      buffer: await page.screenshot({ type }),
      labels: boxes.length,
      skipped,
    };
  } finally {
    await page.evaluate(() => {
      document.querySelectorAll('[data-openclaw-labels]').forEach((el) => el.remove());
    }).catch(() => {});
  }
}
