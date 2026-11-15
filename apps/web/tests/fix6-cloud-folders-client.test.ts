import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import {
  attachCloudFolder,
  listCloudFolderChildren,
  openCloudFolderFile,
} from '../src/lib/api/cloud-folders';

/** FIX6 C3, browser half: folders are attached by provider ids only; the portal has its own path. */
function recording() {
  const calls: { url: string; body: unknown }[] = [];
  const client = new ApiClient({
    baseUrl: 'https://app.example.test',
    csrfCookieName: 'c',
    readCsrfToken: () => 't',
    newCorrelationId: () => 'x',
    fetch: ((url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? 'null')) });
      return Promise.resolve(
        new Response(JSON.stringify({ folder: { id: 'f1' }, files: [], nextPageToken: null }), {
          status: 200,
        }),
      );
    }) as typeof fetch,
  });
  return { client, calls };
}

describe('FIX6 C3 — cloud folder client', () => {
  it('attaches with ids only and lists a subfolder through the portal path', async () => {
    const { client, calls } = recording();
    await attachCloudFolder(client, 'acme', 'wi-1', { provider: 'google_drive', folderId: 'F_1' });
    await listCloudFolderChildren(client, 'acme', 'wi-1', 'f1', 'portal', { parentId: 'S 1' });
    expect(calls[0]).toEqual({
      url: 'https://app.example.test/v1/organizations/acme/work-items/wi-1/cloud-folders/',
      body: { provider: 'google_drive', folderId: 'F_1' },
    });
    expect(calls[1]?.url).toBe(
      'https://app.example.test/v1/organizations/acme/portal/work-items/wi-1/cloud-folders/f1/children?parentId=S+1',
    );
    await openCloudFolderFile(client, 'acme', 'wi-1', 'f1', 'a/b', 'portal');
    expect(calls[2]?.url).toBe(
      'https://app.example.test/v1/organizations/acme/portal/work-items/wi-1/cloud-folders/f1/items/a%2Fb/copy',
    );
  });
});
