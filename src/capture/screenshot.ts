import {
  getPageForTargetId,
  ensurePageState,
  restoreRoleRefsForTarget,
  refLocator,
} from '../connection.js';

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
  refs: string[];
  maxLabels?: number;
  type?: 'png' | 'jpeg';
}): Promise<{ buffer: Buffer; labels: Array<{ ref: string; index: number; box: { x: number; y: number; width: number; height: number } }>; skipped: string[] }> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });

  const maxLabels = typeof opts.maxLabels === 'number' && Number.isFinite(opts.maxLabels)
    ? Math.max(1, Math.floor(opts.maxLabels)) : 150;
  const type = opts.type ?? 'png';
  const refs = opts.refs.slice(0, maxLabels);
  const skipped = opts.refs.slice(maxLabels);

  const viewport = await page.evaluate(() => ({
    scrollX: window.scrollX || 0,
    scrollY: window.scrollY || 0,
    width: window.innerWidth || 0,
    height: window.innerHeight || 0,
  }));

  const labels: Array<{ ref: string; index: number; box: { x: number; y: number; width: number; height: number } }> = [];
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i]!;
    try {
      const locator = refLocator(page, ref);
      const box = await locator.boundingBox({ timeout: 2000 });
      if (!box) {
        skipped.push(ref);
        continue;
      }
      // Viewport clipping: skip elements entirely outside the visible area
      const x1 = box.x + box.width;
      const y1 = box.y + box.height;
      if (x1 < 0 || box.x > viewport.width || y1 < 0 || box.y > viewport.height) {
        skipped.push(ref);
        continue;
      }
      labels.push({ ref, index: i + 1, box });
    } catch {
      skipped.push(ref);
    }
  }

  try {
    if (labels.length > 0) {
      await page.evaluate((labelData: Array<{ index: number; box: { x: number; y: number; width: number; height: number } }>) => {
        document.querySelectorAll('[data-browserclaw-labels]').forEach((el) => el.remove());
        const root = document.createElement('div');
        root.setAttribute('data-browserclaw-labels', '1');
        root.style.position = 'fixed';
        root.style.left = '0';
        root.style.top = '0';
        root.style.zIndex = '2147483647';
        root.style.pointerEvents = 'none';
        root.style.fontFamily = '"SF Mono","SFMono-Regular",Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace';
        const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
        for (const label of labelData) {
          const bx = document.createElement('div');
          bx.setAttribute('data-browserclaw-labels', '1');
          bx.style.position = 'absolute';
          bx.style.left = `${label.box.x}px`;
          bx.style.top = `${label.box.y}px`;
          bx.style.width = `${label.box.width}px`;
          bx.style.height = `${label.box.height}px`;
          bx.style.border = '2px solid #ffb020';
          bx.style.boxSizing = 'border-box';
          const tag = document.createElement('div');
          tag.setAttribute('data-browserclaw-labels', '1');
          tag.textContent = String(label.index);
          tag.style.position = 'absolute';
          tag.style.left = `${label.box.x}px`;
          tag.style.top = `${clamp(label.box.y - 18, 0, 20000)}px`;
          tag.style.background = '#ffb020';
          tag.style.color = '#1a1a1a';
          tag.style.fontSize = '12px';
          tag.style.lineHeight = '14px';
          tag.style.padding = '1px 4px';
          tag.style.borderRadius = '3px';
          tag.style.boxShadow = '0 1px 2px rgba(0,0,0,0.35)';
          tag.style.whiteSpace = 'nowrap';
          root.appendChild(bx);
          root.appendChild(tag);
        }
        document.documentElement.appendChild(root);
      }, labels.map(l => ({ index: l.index, box: l.box })));
    }
    return {
      buffer: await page.screenshot({ type }),
      labels,
      skipped,
    };
  } finally {
    await page.evaluate(() => {
      document.querySelectorAll('[data-browserclaw-labels]').forEach((el) => el.remove());
    }).catch(() => {});
  }
}
