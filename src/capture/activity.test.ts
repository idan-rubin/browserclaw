import { EventEmitter } from 'node:events';

import type { Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';

import { ensurePageState } from '../connection.js';
import { ensurePageState as observePage } from '../page-utils.js';
import type { PageState } from '../types.js';

import { getNetworkRequestsViaPlaywright } from './activity.js';

vi.mock('../connection.js', () => ({ getPageForTargetId: vi.fn(), ensurePageState: vi.fn() }));

describe('network request filter', () => {
  it('filters by a suffix beyond 2048 characters and returns the complete request URL', async () => {
    const page = new EventEmitter();
    const url = `https://example.test/?signature=${'x'.repeat(2100)}&token=tail`;
    const state = observePage(page as unknown as Page);
    page.emit('request', { url: () => url, method: () => 'GET', resourceType: () => 'xhr' });
    vi.mocked(ensurePageState).mockReturnValue(state);
    const { requests } = await getNetworkRequestsViaPlaywright({ cdpUrl: 'local', filter: 'token=tail' });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(url);
  });
  it('matches resource types as well as URLs without changing the result shape', async () => {
    const requests = [
      { id: 'r1', timestamp: '', method: 'GET', url: 'https://example.com/data', resourceType: 'xhr' },
      { id: 'r2', timestamp: '', method: 'GET', url: 'https://example.com/xhr-doc', resourceType: 'document' },
      { id: 'r3', timestamp: '', method: 'GET', url: 'https://example.com/other', resourceType: 'image' },
    ];
    vi.mocked(ensurePageState).mockReturnValue({ requests } as PageState);
    expect(await getNetworkRequestsViaPlaywright({ cdpUrl: 'http://localhost:9222', filter: 'xhr' })).toEqual({
      requests: requests.slice(0, 2),
    });
    expect(await getNetworkRequestsViaPlaywright({ cdpUrl: 'http://localhost:9222' })).toEqual({ requests });
  });
});
