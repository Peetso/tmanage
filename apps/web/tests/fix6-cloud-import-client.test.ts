import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { importDriveFileToWorkItem } from '../src/lib/api/google-drive';
import { importOneDriveFileToWorkItem } from '../src/lib/api/onedrive';
import { importCloudFileForDeliverable } from '../src/lib/api/deliverables';
import { importCloudFileFor } from '../src/lib/api/uploads';
import { ApiRequestError } from '../src/lib/api/errors';
import { cloudImportMessageKey } from '../src/lib/cloud-import-copy';
import en from '../src/lib/i18n/messages/en.json';
import ar from '../src/lib/i18n/messages/ar.json';

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

/** A client that answers each request from a script, in order, and records what was asked. */
function scripted(replies: readonly { status: number; body: unknown }[]) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  let next = 0;
  const client = new ApiClient({
    baseUrl: 'https://app.example.test',
    csrfCookieName: 'c',
    readCsrfToken: () => 't',
    newCorrelationId: () => 'x',
    fetch: ((url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? 'GET',
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      const reply = replies[next++] ?? { status: 204, body: null };
      return Promise.resolve(
        reply.status === 204
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify(reply.body), { status: reply.status }),
      );
    }) as typeof fetch,
  });
  return { client, calls };
}

const copy = (status: string, usable: boolean) => ({
  id: 'asset-1',
  name: 'brief.pdf',
  status,
  usable,
});

describe('FIX6 C2 — a deliverable version from a drive file', () => {
  it('posts the picked ids to the deliverable route, waits for the checks, then adds the version', async () => {
    const { client, calls } = scripted([
      { status: 201, body: { file: copy('uploaded', false), uploadSessionId: 'sess-1' } },
      { status: 200, body: copy('ready', true) },
    ]);
    const added: string[] = [];
    const result = await importCloudFileFor(
      client,
      'acme',
      () =>
        importCloudFileForDeliverable(client, 'acme', 'd-1', {
          provider: 'onedrive',
          driveId: 'b!d',
          itemId: 'I!1',
        }),
      async (id) => {
        added.push(id);
        return 'version';
      },
      { sleep: async () => undefined },
    );
    expect(result).toBe('version');
    expect(added).toEqual(['asset-1']);
    expect(calls[0]).toEqual({
      method: 'POST',
      url: 'https://app.example.test/v1/organizations/acme/deliverables/d-1/onedrive-files',
      body: { driveId: 'b!d', itemId: 'I!1' },
    });
    expect(calls[1]?.url).toBe(
      'https://app.example.test/v1/organizations/acme/upload-sessions/sess-1/complete',
    );
  });

  it('removes the copy again when the version is refused', async () => {
    const { client, calls } = scripted([
      { status: 201, body: { file: copy('ready', true), uploadSessionId: 'sess-1' } },
    ]);
    await expect(
      importCloudFileFor(
        client,
        'acme',
        () =>
          importCloudFileForDeliverable(client, 'acme', 'd-1', {
            provider: 'google_drive',
            fileId: 'FILE_1',
          }),
        () => Promise.reject(new Error('refused')),
      ),
    ).rejects.toThrow('refused');
    expect(calls.at(-1)?.method).toBe('DELETE');
    expect(calls.at(-1)?.url).toContain('/files/asset-1');
  });

  it('names each refusal in plain words, in English and Arabic', () => {
    const refusal = (status: number, field: string, message: string) =>
      new ApiRequestError(status, 'not_found', 'x', 'c', [{ field, message }]);
    const cases = [
      [refusal(404, 'file', 'drive_file_gone'), 'CloudImport.fileGone'],
      [refusal(403, 'file', 'drive_no_access'), 'CloudImport.noAccess'],
      [refusal(422, 'file', 'google_native_format'), 'CloudImport.googleNative'],
      [refusal(422, 'reason', 'too_large'), 'CloudImport.tooLarge'],
      [refusal(409, 'storage', 'not_connected'), 'CloudImport.notConnected'],
      [refusal(409, 'storage', 'unreachable'), 'CloudImport.unreachable'],
    ] as const;
    for (const [error, key] of cases) {
      expect(cloudImportMessageKey(error)).toBe(key);
      expect((en as Record<string, string>)[key]).toBeTruthy();
      expect((ar as Record<string, string>)[key]).toMatch(/[؀-ۿ]/u);
    }
    expect(cloudImportMessageKey(new Error('other'))).toBeNull();
  });
});
