import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import * as od from '../src/lib/api/onedrive';
import { buildPickerOptions, pickerUrl, readPickedItems } from '../src/lib/onedrive-picker';

/** OneDrive (0236), browser half: the return fragment, routing, chunked upload and the picker. */
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const status = (mode: string, state: string) =>
  ({ storageMode: mode, oneDrive: { status: state } }) as unknown as od.OneDriveStatusView;

describe('OneDrive storage (web)', () => {
  it('reads the callback fragment and routes uploads only when OneDrive is the live storage', () => {
    expect(od.readOneDriveReturn('#onedrive=complete&code=c&state=s')).toMatchObject({ code: 'c' });
    expect(od.readOneDriveReturn('#drive=complete&code=c&state=s')).toBeNull();
    expect(od.uploadsGoToOneDrive(status('onedrive', 'connected'))).toBe(true);
    expect(od.uploadsGoToOneDrive(status('google_drive', 'connected'))).toBe(false);
  });

  it('PUTs Content-Range chunks to the upload URL without cookies, then attaches the item', async () => {
    const puts: string[] = [];
    const bodies: unknown[] = [];
    const client = new ApiClient({
      baseUrl: 'https://app.example.test',
      csrfCookieName: 'c',
      readCsrfToken: () => 't',
      newCorrelationId: () => 'x',
      fetch: ((url: string, init?: RequestInit) => {
        bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
        return Promise.resolve(
          String(url).endsWith('/uploads')
            ? json({ uploadUrl: 'https://up.ms/s' }, 201)
            : json({ id: 'a1' }, 201),
        );
      }) as typeof fetch,
    });
    const size = od.ONEDRIVE_CHUNK_BYTES + 5;
    const put = ((_url: string, init?: RequestInit) => {
      puts.push(`${new Headers(init?.headers).get('content-range')} ${init?.credentials}`);
      return Promise.resolve(
        puts.length === 1
          ? new Response(null, { status: 202 })
          : json({ id: 'it-1', parentReference: { driveId: 'dr-1' } }, 201),
      );
    }) as typeof fetch;
    const file = new File([new Uint8Array(size)], 'a.pdf');
    await od.uploadToOneDrive(client, 'acme', 'wi-1', file, put);
    expect(puts).toEqual([
      `bytes 0-${od.ONEDRIVE_CHUNK_BYTES - 1}/${size} omit`,
      `bytes ${od.ONEDRIVE_CHUNK_BYTES}-${size - 1}/${size} omit`,
    ]);
    expect(bodies[1]).toEqual({ driveId: 'dr-1', itemId: 'it-1' });
  });

  it('builds the v8 picker for both account types and keeps only well-formed picks', () => {
    const base = 'https://acme-my.sharepoint.com';
    const work = { accountType: 'business' as const, baseUrl: base, librariesEnabled: true };
    const options = buildPickerOptions(work, 'folder', 'https://app.test');
    expect(options).toMatchObject({
      entry: { sharePoint: { byPath: { web: 'https://acme.sharepoint.com' } } },
      typesAndSources: { mode: 'folders' },
      selection: { mode: 'single' },
    });
    expect(pickerUrl(work, options, 'en')).toMatch(
      /^https:\/\/acme-my\.sharepoint\.com\/_layouts\/15\/FilePicker\.aspx\?filePicker=/,
    );
    expect(
      readPickedItems([
        { id: 'i', name: 'n', size: 3, parentReference: { driveId: 'd' } },
        { id: 'x' },
      ]),
    ).toEqual([{ driveId: 'd', itemId: 'i', name: 'n', size: 3, webUrl: null }]);
  });
});
