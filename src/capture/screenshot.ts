import { assertPageNavigationCompletedSafely } from '../actions/navigation.js';
import { getPageForTargetId, ensurePageState, refLocator } from '../connection.js';
import type { SsrfPolicy } from '../types.js';

export async function takeScreenshotViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  fullPage?: boolean;
  ref?: string;
  element?: string;
  type?: 'png' | 'jpeg';
  ssrfPolicy?: SsrfPolicy;
}): Promise<{ buffer: Buffer }> {
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    ssrfPolicy: opts.ssrfPolicy,
  });
  ensurePageState(page);

  if (opts.ssrfPolicy) {
    await assertPageNavigationCompletedSafely({
      cdpUrl: opts.cdpUrl,
      page,
      response: null,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
  }

  const type = opts.type ?? 'png';

  if (opts.ref !== undefined && opts.ref !== '') {
    if (opts.fullPage === true) throw new Error('fullPage is not supported for element screenshots');
    return { buffer: await refLocator(page, opts.ref).screenshot({ type }) };
  }
  if (opts.element !== undefined && opts.element !== '') {
    if (opts.fullPage === true) throw new Error('fullPage is not supported for element screenshots');
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
  ssrfPolicy?: SsrfPolicy;
}): Promise<{
  buffer: Buffer;
  labels: { ref: string; index: number; box: { x: number; y: number; width: number; height: number } }[];
  skipped: string[];
}> {
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    ssrfPolicy: opts.ssrfPolicy,
  });
  ensurePageState(page);

  if (opts.ssrfPolicy) {
    await assertPageNavigationCompletedSafely({
      cdpUrl: opts.cdpUrl,
      page,
      response: null,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
  }

  const maxLabels =
    typeof opts.maxLabels === 'number' && Number.isFinite(opts.maxLabels)
      ? Math.max(1, Math.floor(opts.maxLabels))
      : 150;
  const type = opts.type ?? 'png';
  const refs = opts.refs.slice(0, maxLabels);
  const skipped = opts.refs.slice(maxLabels);

  const viewport = await page.evaluate(() => ({
    width: window.innerWidth || 0,
    height: window.innerHeight || 0,
  }));

  const labels: { ref: string; index: number; box: { x: number; y: number; width: number; height: number } }[] = [];
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
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
      await page.evaluate(
        (labelData: { index: number; box: { x: number; y: number; width: number; height: number } }[]) => {
          document.querySelectorAll('[data-browserclaw-labels]').forEach((el) => {
            el.remove();
          });
          const container = document.createElement('div');
          container.setAttribute('data-browserclaw-labels', '1');
          container.style.cssText =
            'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;';
          for (const { index, box } of labelData) {
            const border = document.createElement('div');
            border.style.cssText = `position:absolute;left:${String(box.x)}px;top:${String(box.y)}px;width:${String(box.width)}px;height:${String(box.height)}px;border:2px solid #FF4500;box-sizing:border-box;`;
            container.appendChild(border);
            const badge = document.createElement('div');
            badge.textContent = String(index);
            badge.style.cssText = `position:absolute;left:${String(box.x)}px;top:${String(Math.max(0, box.y - 18))}px;background:#FF4500;color:#fff;font:bold 12px/16px monospace;padding:0 4px;border-radius:2px;`;
            container.appendChild(badge);
          }
          document.documentElement.appendChild(container);
        },
        labels.map((l) => ({ index: l.index, box: l.box })),
      );
    }
    return {
      buffer: await page.screenshot({ type }),
      labels,
      skipped,
    };
  } finally {
    await page
      .evaluate(() => {
        document.querySelectorAll('[data-browserclaw-labels]').forEach((el) => {
          el.remove();
        });
      })
      .catch((err: unknown) => {
        console.warn(`[browserclaw] label overlay cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }
}
