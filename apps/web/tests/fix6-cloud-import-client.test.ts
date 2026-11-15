import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { importDriveFileToWorkItem } from '../src/lib/api/google-drive';
import { importOneDriveFileToWorkItem } from '../src/lib/api/onedrive';

/**
 * FIX6 C1, browser half: a picked drive file is sent to the import routes as provider ids only
 * (never a link), and the answer is the new TManage copy's id.
 */
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
        new Response(JSON.stringify({ file: { id: 'asset-1' }, uploadSessionId: 's' }), {
          status: 201,
        }),
      );
    }) as typeof fetch,
  });
  return { client, calls };
}

describe('FIX6 C1 — drive files become checked copies', () => {
  it('imports a Drive file by its id into the work item', async () => {
    const { client, calls } = recording();
    expect(await importDriveFileToWorkItem(client, 'acme', 'w-1', 'FILE_1')).toBe('asset-1');
    expect(calls).toEqual([
      {
        url: 'https://app.example.test/v1/organizations/acme/work-items/w-1/drive-files',
        body: { fileId: 'FILE_1' },
      },
    ]);
  });

  it('imports a OneDrive item by drive and item id, sending nothing else', async () => {
    const { client, calls } = recording();
    await importOneDriveFileToWorkItem(client, 'acme', 'w-1', {
      driveId: 'b!d',
      itemId: 'I!1',
      name: 'brief.pdf',
      size: 3,
      webUrl: 'https://contoso.sharepoint.com/x',
    } as never);
    expect(calls[0]?.url).toBe(
      'https://app.example.test/v1/organizations/acme/work-items/w-1/onedrive-files',
    );
    expect(calls[0]?.body).toEqual({ driveId: 'b!d', itemId: 'I!1' });
  });
});
