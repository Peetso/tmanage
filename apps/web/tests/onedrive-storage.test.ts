import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import * as od from '../src/lib/api/onedrive';
import { buildPickerOptions, pickerUrl, readPickedItems } from '../src/lib/onedrive-picker';
import { trailAfterOpen, trailBackTo } from '../src/components/storage/OneDriveFolderDialog';

/** OneDrive (0236), browser half: the return fragment, folder browsing and the picker. */
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('OneDrive storage (web)', () => {
  it('reads the callback fragment', () => {
    expect(od.readOneDriveReturn('#onedrive=complete&code=c&state=s')).toMatchObject({ code: 'c' });
    expect(od.readOneDriveReturn('#drive=complete&code=c&state=s')).toBeNull();
  });

  it('R36 F2: Change folder browses the API, not the Microsoft picker, and walks the path', async () => {
    const urls: string[] = [];
    const client = new ApiClient({
      baseUrl: 'https://app.example.test',
      csrfCookieName: 'c',
      readCsrfToken: () => 't',
      newCorrelationId: () => 'x',
      fetch: ((url: string) => {
        urls.push(String(url));
        return Promise.resolve(
          json({ driveId: 'd', folder: { id: 'f', name: 'A', isDriveRoot: false }, folders: [] }),
        );
      }) as typeof fetch,
    });
    await od.browseOneDriveFolders(client, 'acme', { folderId: 'F!123', pageToken: 'p' });
    expect(urls[0]).toBe(
      'https://app.example.test/v1/organizations/acme/integrations/onedrive/folders?folderId=F%21123&pageToken=p',
    );
    const top = [{ id: undefined, name: 'My files' }];
    const deep = trailAfterOpen(trailAfterOpen(top, { id: 'A!1', name: 'A' }), {
      id: 'B!1',
      name: 'B',
    });
    expect(deep.map((step) => step.name)).toEqual(['My files', 'A', 'B']);
    expect(trailBackTo(deep, 0)).toEqual(top);
    expect(trailBackTo(deep, -5)).toEqual(top);
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
