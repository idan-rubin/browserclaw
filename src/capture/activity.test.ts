import { describe, expect, it, vi } from 'vitest';

import { ensurePageState } from '../connection.js';
import type { PageState } from '../types.js';

import { getNetworkRequestsViaPlaywright } from './activity.js';

vi.mock('../connection.js', () => ({ getPageForTargetId: vi.fn(), ensurePageState: vi.fn() }));

describe('network request filter', () => {
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
