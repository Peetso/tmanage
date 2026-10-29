import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/lib/api/client';
import {
  endPlatformSession,
  listPlatformActions,
  platformExportDownloadPath,
  requestPlatformExport,
} from '../src/lib/api/platform-activity';
import { filterHref, moment } from '../src/components/platform/activity/ActivityFrame';

/** platform-admin v2 · PA-09 — the Activity & access client and helpers. */

function fakeClient(data: unknown) {
  const request = vi.fn().mockResolvedValue({ data });
  return { client: { request } as unknown as ApiClient, request };
}

describe('platform activity client', () => {
  it('sends only the filled filter keys and the cursor', async () => {
    const { client, request } = fakeClient({ actions: [], nextCursor: null });
    await listPlatformActions(client, { organizationId: 'org-1', q: '', result: undefined }, 'c1');
    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      path: '/v1/platform/activity/actions?organizationId=org-1&cursor=c1',
    });
  });

  it('ends a session with its reason in the body', async () => {
    const { client, request } = fakeClient({ ended: true, userId: 'u1' });
    await endPlatformSession(client, 'sess/1', 'Lost laptop');
    expect(request).toHaveBeenCalledWith({
      method: 'DELETE',
      path: '/v1/platform/activity/access/sessions/sess%2F1',
      body: { reason: 'Lost laptop' },
    });
  });

  it('queues an export with a cleaned filter and no empty reason', async () => {
    const { client, request } = fakeClient({ id: 'job-1' });
    await requestPlatformExport(client, {
      scope: 'actions',
      filter: { organizationId: 'org-1', q: '' },
      reason: null,
    });
    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/platform/activity/exports',
      body: { scope: 'actions', filter: { organizationId: 'org-1' } },
    });
  });

  it('builds the download path', () => {
    expect(platformExportDownloadPath('job-1')).toBe(
      '/v1/platform/activity/exports/job-1/download',
    );
  });
});

describe('activity helpers', () => {
  it('formats a moment in UTC and a dash for nothing', () => {
    expect(moment('2026-10-28T13:52:09.000Z')).toBe('2026-10-28 13:52 UTC');
    expect(moment(null)).toBe('—');
  });

  it('builds a deep link from a filter, leaving out empty values', () => {
    expect(filterHref('/platform/activity', { ip: '10.0.0.1', q: '' })).toBe(
      '/platform/activity?ip=10.0.0.1',
    );
    expect(filterHref('/platform/activity', {})).toBe('/platform/activity');
  });
});
