import { getPageForTargetId, ensurePageState } from '../connection.js';

export async function pdfViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<{ buffer: Buffer }> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  return { buffer: await page.pdf({ printBackground: true }) };
}
