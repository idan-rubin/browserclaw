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

  const maxLabels = opts.maxLabels ?? 50;
  const type = opts.type ?? 'png';
  const refs = opts.refs.slice(0, maxLabels);
  const skipped = opts.refs.slice(maxLabels);

  // Collect bounding boxes for each ref
  const labels: Array<{ ref: string; index: number; box: { x: number; y: number; width: number; height: number } }> = [];
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i]!;
    try {
      const locator = refLocator(page, ref);
      const box = await locator.boundingBox({ timeout: 2000 });
      if (box) {
        labels.push({ ref, index: i + 1, box });
      } else {
        skipped.push(ref);
      }
    } catch {
      skipped.push(ref);
    }
  }

  // Inject visible label overlays into the page
  await page.evaluate((labelData: Array<{ index: number; box: { x: number; y: number; width: number; height: number } }>) => {
    const container = document.createElement('div');
    container.id = '__browserclaw_labels__';
    container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;';
    for (const { index, box } of labelData) {
      // Border around element
      const border = document.createElement('div');
      border.style.cssText = `position:absolute;left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px;border:2px solid #FF4500;box-sizing:border-box;`;
      container.appendChild(border);
      // Label badge
      const badge = document.createElement('div');
      badge.textContent = String(index);
      badge.style.cssText = `position:absolute;left:${box.x}px;top:${Math.max(0, box.y - 18)}px;background:#FF4500;color:#fff;font:bold 12px/16px monospace;padding:0 4px;border-radius:2px;`;
      container.appendChild(badge);
    }
    document.body.appendChild(container);
  }, labels.map(l => ({ index: l.index, box: l.box })));

  // Take the screenshot with labels visible
  const buffer = await page.screenshot({ type });

  // Remove the label overlays (best-effort — page may have navigated)
  await page.evaluate(() => {
    const el = document.getElementById('__browserclaw_labels__');
    if (el) el.remove();
  }).catch(() => {});

  return { buffer, labels, skipped };
}
