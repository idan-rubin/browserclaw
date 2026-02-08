import { getPageForTargetId, ensurePageState } from '../connection.js';
import type { ConsoleMessage, PageError, NetworkRequest } from '../types.js';

function consolePriority(level: string): number {
  switch (level) {
    case 'error': return 3;
    case 'warning': return 2;
    case 'info':
    case 'log': return 1;
    case 'debug': return 0;
    default: return 1;
  }
}

export async function getConsoleMessagesViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  level?: string;
}): Promise<ConsoleMessage[]> {
  const state = ensurePageState(await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId }));
  if (!opts.level) return [...state.console];
  const min = consolePriority(opts.level);
  return state.console.filter(msg => consolePriority(msg.type) >= min);
}

export async function getPageErrorsViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  clear?: boolean;
}): Promise<{ errors: PageError[] }> {
  const state = ensurePageState(await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId }));
  const errors = [...state.errors];
  if (opts.clear) state.errors = [];
  return { errors };
}

export async function getNetworkRequestsViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  filter?: string;
  clear?: boolean;
}): Promise<{ requests: NetworkRequest[] }> {
  const state = ensurePageState(await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId }));
  const raw = [...state.requests];
  const filter = typeof opts.filter === 'string' ? opts.filter.trim() : '';
  const requests = filter ? raw.filter(r => r.url.includes(filter)) : raw;
  if (opts.clear) {
    state.requests = [];
    state.requestIds = new WeakMap();
  }
  return { requests };
}
