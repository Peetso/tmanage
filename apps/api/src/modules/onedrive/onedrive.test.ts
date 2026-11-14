import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { parseSeedKeys } from '@tmanage/config';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { StorageConnectionRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import { createSeedCipher } from '../identity/seed-cipher.js';
import { parseConnectReturnTo } from '../platform-admin/connect-setup/connect-return.js';
import { oneDriveCallbackTarget, parseOneDriveSettings } from './onedrive.controller.js';
import {
  ONEDRIVE_FLOW_COOKIE,
  OneDriveGrantRevokedError,
  OneDriveItemNotFoundError,
  isGraphId,
  newOneDriveFlow,
  oneDriveConfigFrom,
  oneDriveFolderName,
  openOneDriveFlow,
  sealOneDriveFlow,
  skipTokenOf,
  type OneDriveTransport,
} from './onedrive.graph.js';
import type { OneDriveRepository } from './onedrive.repository.js';
import {
  OneDriveService,
  grantsLibraries,
  oneDriveFolderPath,
  pickerTarget,
  safeOneDriveLink,
  toOneDriveStatusView,
  tokenBinding,
} from './onedrive.service.js';

const SECRET = 'session-secret-for-tests-only-0123456789';
const CIPHER = createSeedCipher(parseSeedKeys(`1:${Buffer.alloc(32, 0x44).toString('base64url')}`));
const CONFIG = { clientId: 'cid', clientSecret: 'csecret', tenant: 'common' };
const ORG = 'org-a';
const PROJECT = '01890000-0000-7000-8000-000000000101';
const ctx = (organizationId = ORG) =>
  ({ organizationId, userId: 'user-1', correlationId: 'c' }) as unknown as TenantContext;
const principal = (hasOrgWideScope: boolean) =>
  ({
    userId: 'user-1',
    organizationId: ORG,
    kind: 'internal',
    role: hasOrgWideScope ? 'owner' : 'member',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT],
    hasOrgWideScope,
  }) as unknown as Principal;
const database = {
  read: (_c: unknown, work: (r: unknown) => unknown) => work({}),
  transaction: (_c: unknown, work: (r: unknown) => unknown) => work({}),
} as unknown as TenantDatabase;

function setup(
  initial?: Partial<StorageConnectionRow>,
  overrides: Partial<OneDriveTransport> = {},
) {
  let row = initial
    ? ({
        id: 'conn-1',
        provider: 'onedrive',
        storageMode: 'tmanage',
        status: 'connected',
        rootFolderId: 'ROOT!1',
        onedriveDriveId: 'drive1',
        refreshTokenEnc: CIPHER.encrypt('old-refresh', tokenBinding(ORG)),
        grantedScopes: 'Files.ReadWrite offline_access',
        ...initial,
      } as StorageConnectionRow)
    : undefined;
  const repository = {
    findConnection: vi.fn(async () => row),
    saveConnected: vi.fn(async (_r: unknown, _c: unknown, input: Record<string, unknown>) => {
      row = { id: 'conn-1', status: 'connected', ...input } as unknown as StorageConnectionRow;
    }),
    update: vi.fn(async (_r: unknown, _c: unknown, _id: string, patch: object) => {
      row = { ...(row as StorageConnectionRow), ...patch };
    }),
    storeRotatedToken: vi.fn(async (_r: unknown, _c: unknown, _id: string, enc: string) => {
      row = { ...(row as StorageConnectionRow), refreshTokenEnc: enc };
    }),
    findKnownFolder: vi.fn(async () => undefined),
    isKnownRoot: vi.fn(async () => false),
  };
  const transport: OneDriveTransport = {
    exchangeCode: vi.fn(async () => ({
      accessToken: 'at',
      refreshToken: 'first-refresh',
      scope: 'Files.ReadWrite',
      email: 'owner@example.com',
    })),
    refreshTokens: vi.fn(async () => ({
      accessToken: 'fresh',
      refreshToken: 'rotated',
      scope: null,
    })),
    myDrive: vi.fn(async () => ({
      id: 'drive1',
      name: 'OneDrive',
      driveType: 'personal',
      webUrl: null,
    })),
    getDrive: vi.fn(),
    ensureFolder: vi.fn(async () => 'ROOT!1'),
    getItem: vi.fn(),
    listChildren: vi.fn(),
    ...overrides,
  };
  const audit = { record: vi.fn(async () => ({})) };
  const service = new OneDriveService({
    database,
    audit: audit as unknown as AuditService,
    transport,
    cipher: CIPHER,
    config: CONFIG,
    apiPublicUrl: 'https://tmanage.example.com',
    repository: repository as unknown as OneDriveRepository,
    workItems: {
      findById: vi.fn(async () => ({
        id: 'wi-1',
        organizationId: ORG,
        projectId: PROJECT,
        audience: 'internal',
        state: 'open',
        deletedAt: null,
      })),
    } as never,
    projects: {
      findById: vi.fn(async () => ({ id: PROJECT, organizationId: ORG, archivedAt: null })),
    } as never,
    storageModes: { effective: vi.fn(async () => 'tmanage' as const), switchTo: vi.fn() },
  });
  return { service, repository, transport, audit, current: () => row };
}

describe('configuration and the flow cookie', () => {
  it('is off without both secrets; the tenant defaults to common and is sanitised', () => {
    expect(oneDriveConfigFrom({})).toBeNull();
    expect(oneDriveConfigFrom({ MICROSOFT_CLIENT_ID: 'x' })).toBeNull();
    const env = { MICROSOFT_CLIENT_ID: 'a', MICROSOFT_CLIENT_SECRET: 'b' };
    expect(oneDriveConfigFrom(env)?.tenant).toBe('common');
    expect(oneDriveConfigFrom({ ...env, MICROSOFT_TENANT: 'x/../y' })?.tenant).toBe('common');
  });

  it('refuses a forged, expired or malformed cookie', () => {
    const flow = newOneDriveFlow(
      { organizationId: ORG, organizationSlug: 'acme', userId: 'u', libraries: false },
      1000,
    );
    const sealed = sealOneDriveFlow(flow, SECRET);
    expect(openOneDriveFlow(sealed, SECRET, 1000)?.state).toBe(flow.state);
    expect(openOneDriveFlow(sealed, 'other-secret', 1000)).toBeUndefined();
    expect(openOneDriveFlow(sealed, SECRET, 5000)).toBeUndefined();
    expect(openOneDriveFlow(`${sealed}.x`, SECRET, 1000)).toBeUndefined();
  });

  it('forwards the code in the fragment only for a valid cookie', () => {
    const flow = newOneDriveFlow({
      organizationId: ORG,
      organizationSlug: 'acme',
      userId: 'u',
      libraries: false,
    });
    const cookie = `${ONEDRIVE_FLOW_COOKIE}=${sealOneDriveFlow(flow, SECRET)}`;
    const options = { sessionSecret: SECRET, webPublicUrl: 'https://app.example.com/' };
    expect(oneDriveCallbackTarget(options, cookie, 'c', 's')).toBe(
      'https://app.example.com/acme/admin/storage#onedrive=complete&code=c&state=s',
    );
    expect(oneDriveCallbackTarget(options, undefined, 'c', 's')).toBe('https://app.example.com/');
  });

  it('R38: returns to Connected apps when started there, forwarding an explained error', () => {
    const flow = newOneDriveFlow({
      organizationId: ORG,
      organizationSlug: 'acme',
      userId: 'u',
      libraries: false,
    });
    const sealed = sealOneDriveFlow({ ...flow, returnTo: 'connected_apps' }, SECRET);
    const cookie = `${ONEDRIVE_FLOW_COOKIE}=${sealed}`;
    const options = { sessionSecret: SECRET, webPublicUrl: 'https://app.example.com' };
    const screen = 'https://app.example.com/acme/settings/connected-apps';
    expect(oneDriveCallbackTarget(options, cookie, 'c', 's')).toBe(
      `${screen}#onedrive=complete&code=c&state=s`,
    );
    expect(oneDriveCallbackTarget(options, cookie, undefined, undefined, 'access_denied')).toBe(
      `${screen}#onedrive=error&reason=access_denied`,
    );
    // An unexplained or injected error value never reaches the address bar.
    expect(oneDriveCallbackTarget(options, cookie, undefined, undefined, '<x>&y=1')).toBe(
      `${screen}#onedrive=error`,
    );
    // A cookie claiming an unknown return screen is refused as a whole.
    const odd = sealOneDriveFlow({ ...flow, returnTo: 'elsewhere' as never }, SECRET);
    expect(openOneDriveFlow(odd, SECRET)).toBeUndefined();
  });

  it('R38: accepts only connected-apps as a connect returnTo', () => {
    expect(parseConnectReturnTo(undefined)).toBeUndefined();
    expect(parseConnectReturnTo('connected-apps')).toBe('connected_apps');
    expect(parseConnectReturnTo('https://evil.example')).toBe('invalid');
  });
});

describe('connecting', () => {
  it('refuses a flow from another organization before Microsoft is called', async () => {
    const { service, transport } = setup();
    const flow = newOneDriveFlow({
      organizationId: 'org-b',
      organizationSlug: 'b',
      userId: 'user-1',
      libraries: false,
    });
    await expect(
      service.completeConnect(ctx(), flow, { code: 'c', state: flow.state }),
    ).rejects.toMatchObject({ status: 400 });
    expect(transport.exchangeCode).not.toHaveBeenCalled();
  });

  it('stores the refresh token encrypted and bound to the organization', async () => {
    const { service, current } = setup();
    const flow = newOneDriveFlow({
      organizationId: ORG,
      organizationSlug: 'a',
      userId: 'user-1',
      libraries: false,
    });
    const view = await service.completeConnect(ctx(), flow, { code: 'c', state: flow.state });
    expect(view.oneDrive.status).toBe('connected');
    const enc = current()?.refreshTokenEnc ?? '';
    expect(enc).not.toContain('first-refresh');
    expect(CIPHER.decrypt(enc, tokenBinding(ORG))).toBe('first-refresh');
    expect(() => CIPHER.decrypt(enc, tokenBinding('org-b'))).toThrow();
  });
});

describe('tokens', () => {
  it('re-stores the rotated refresh token after every refresh', async () => {
    const { service, current } = setup({});
    await service.pickerSession(ctx(), principal(true));
    expect(CIPHER.decrypt(current()?.refreshTokenEnc ?? '', tokenBinding(ORG))).toBe('rotated');
  });

  it('a revoked grant moves the connection to error and answers 409', async () => {
    const refreshTokens = vi.fn(async () => {
      throw new OneDriveGrantRevokedError('gone');
    });
    const { service, current } = setup({}, { refreshTokens });
    await expect(service.pickerSession(ctx(), principal(true))).rejects.toMatchObject({
      status: 409,
    });
    expect(current()).toMatchObject({ status: 'error', lastErrorCode: 'revoked' });
  });

  it('NV10: a project-scoped caller gets no token at all', async () => {
    const { service, transport } = setup({});
    const view = await service.pickerSession(ctx(), principal(false), PROJECT);
    expect(view).toEqual({ mode: 'scoped', projectId: PROJECT });
    expect(transport.refreshTokens).not.toHaveBeenCalled();
  });
});

describe('R36 F2: Change folder', () => {
  const folderItem = (
    id: string,
    parentId: string | null,
    driveId = 'drive1',
    isFolder = true,
  ) => ({
    id,
    driveId,
    name: parentId === null ? 'root' : `name-${id}`,
    mimeType: 'application/octet-stream',
    size: null,
    webUrl: null,
    isFolder,
    parentId,
  });

  it('lists only the sub-folders of the drive top, read with the Graph token', async () => {
    const getItem = vi.fn(async () => folderItem('TOP!1', null));
    const listChildren = vi.fn(async () => ({
      files: [
        {
          id: 'DIR!1',
          name: 'Clients',
          mimeType: '',
          size: null,
          modifiedTime: null,
          isFolder: true,
        },
        { id: 'FILE!1', name: 'a.pdf', mimeType: '', size: 1, modifiedTime: null, isFolder: false },
      ],
      nextPageToken: 'next1',
    }));
    const { service, transport } = setup({}, { getItem, listChildren });
    const view = await service.browseFolders(ctx(), {});
    expect(getItem).toHaveBeenCalledWith('fresh', { driveId: 'drive1', itemId: 'root' });
    expect(view).toEqual({
      driveId: 'drive1',
      folder: { id: 'TOP!1', name: '', isDriveRoot: true },
      folders: [{ id: 'DIR!1', name: 'Clients' }],
      nextPageToken: 'next1',
    });
    expect(transport.refreshTokens).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'openid profile email offline_access Files.ReadWrite' }),
    );
  });

  it('answers 404 for a file or a folder of another drive', async () => {
    const file = setup(
      {},
      { getItem: vi.fn(async () => folderItem('F!123', 'P!123', 'drive1', false)) },
    );
    await expect(file.service.browseFolders(ctx(), { folderId: 'F!123' })).rejects.toMatchObject({
      status: 404,
    });
    const other = setup({}, { getItem: vi.fn(async () => folderItem('D!123', 'P!123', 'drive2')) });
    await expect(other.service.browseFolders(ctx(), { folderId: 'D!123' })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('saves a picked folder as the root and the drive top under the drive name, not "root"', async () => {
    const getItem = vi.fn(async (_t: string, input: { itemId: string }) =>
      input.itemId === 'TOP!1' ? folderItem('TOP!1', null) : folderItem(input.itemId, 'TOP!1'),
    );
    const getDrive = vi.fn(async () => ({
      id: 'drive1',
      name: 'OneDrive',
      driveType: 'personal',
      webUrl: null,
    }));
    const ensureFolder = vi.fn(async () => 'NEWROOT!1');
    const { service, current } = setup({}, { getItem, getDrive, ensureFolder });
    await service.updateSettings(ctx(), {
      location: { kind: 'folder', driveId: 'drive1', itemId: 'DIR!1' },
    });
    expect(ensureFolder).toHaveBeenCalledWith('fresh', {
      driveId: 'drive1',
      parentId: 'DIR!1',
      name: 'TManage',
    });
    expect(current()).toMatchObject({ rootFolderId: 'NEWROOT!1', onedriveDriveName: 'name-DIR!1' });
    await service.updateSettings(ctx(), {
      location: { kind: 'folder', driveId: 'drive1', itemId: 'TOP!1' },
    });
    expect(current()).toMatchObject({ onedriveDriveName: 'OneDrive' });
  });

  it('a refused picker token is a consent problem: the connection stays connected', async () => {
    const refreshTokens = vi.fn(async (input: { scope: string }) => {
      if (input.scope.startsWith('OneDrive.')) throw new OneDriveGrantRevokedError('AADSTS70000');
      return { accessToken: 'fresh', refreshToken: 'rotated', scope: null };
    });
    const { service, current } = setup({}, { refreshTokens });
    await expect(service.pickerSession(ctx(), principal(true))).rejects.toMatchObject({
      status: 409,
      details: [{ field: 'storage', message: 'consent_required' }],
    });
    expect(current()).toMatchObject({ status: 'connected' });
  });
});

describe('the attach check', () => {
  it('refuses a file whose ancestor Graph hides (fail closed)', async () => {
    const getItem = vi.fn(async (_t: string, input: { itemId: string }) => {
      if (input.itemId === 'FILE!1') {
        return {
          id: 'FILE!1',
          driveId: 'drive1',
          name: 'a.pdf',
          mimeType: 'application/pdf',
          size: 1,
          webUrl: null,
          isFolder: false,
          parentId: 'HIDDEN!1',
        };
      }
      throw new OneDriveItemNotFoundError('hidden');
    });
    const { service, repository } = setup({}, { getItem });
    await expect(
      service.attach(ctx(), principal(true), 'wi-1', { driveId: 'drive1', itemId: 'FILE!1' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(repository.isKnownRoot).toHaveBeenCalled();
  });
});

describe('pure rules', () => {
  it('parses settings strictly', () => {
    expect(parseOneDriveSettings({ storageMode: 'onedrive' })).toEqual({ storageMode: 'onedrive' });
    expect(parseOneDriveSettings({ location: { kind: 'library', driveId: 'b!abcde' } })).toEqual({
      location: { kind: 'library', driveId: 'b!abcde' },
    });
    expect(() => parseOneDriveSettings({ storageMode: 'google_drive' })).toThrow();
    expect(() => parseOneDriveSettings({ location: { kind: 'folder', driveId: 'x' } })).toThrow();
    expect(() => parseOneDriveSettings({})).toThrow();
  });

  it('keeps only OneDrive https links and safe names and ids', () => {
    expect(safeOneDriveLink('https://onedrive.live.com/?id=1')).not.toBeNull();
    expect(safeOneDriveLink('https://contoso.sharepoint.com/x')).not.toBeNull();
    expect(safeOneDriveLink('http://onedrive.live.com/')).toBeNull();
    expect(safeOneDriveLink('https://evil.example/onedrive.live.com')).toBeNull();
    expect(oneDriveFolderName(' ..a:b*c?. ', 'F')).toBe('a b c');
    expect(oneDriveFolderName('...', 'F')).toBe('F');
    expect(isGraphId('01ABC!123')).toBe(true);
    expect(isGraphId('../x/y')).toBe(false);
    expect(skipTokenOf('https://graph.microsoft.com/v1.0/x?$skiptoken=abc123')).toBe('abc123');
  });

  it('shows the chosen place in front of TManage/', () => {
    expect(oneDriveFolderPath('Clients')).toBe('Clients/TManage/');
    expect(oneDriveFolderPath(null)).toBe('TManage/');
    const row = {
      status: 'connected',
      accountEmail: 'a@example.com',
      onedriveDriveName: 'Clients',
      grantedScopes: 'Files.ReadWrite',
    } as unknown as Parameters<typeof toOneDriveStatusView>[1];
    expect(toOneDriveStatusView(null, row, true, 'onedrive').oneDrive.folderPath).toBe(
      'Clients/TManage/',
    );
  });

  it('mints picker tokens only for the account’s own origins', () => {
    expect(pickerTarget('personal', null, false, undefined)).toMatchObject({
      accountType: 'personal',
    });
    const web = 'https://contoso-my.sharepoint.com/personal/a/Documents';
    expect(pickerTarget('business', web, false, undefined)).toMatchObject({
      scope: 'https://contoso-my.sharepoint.com/.default offline_access',
    });
    expect(pickerTarget('business', web, false, 'https://contoso.sharepoint.com')).toBe('refused');
    expect(pickerTarget('business', web, true, 'https://contoso.sharepoint.com')).not.toBe(
      'refused',
    );
    expect(pickerTarget('business', web, true, 'https://evil.sharepoint.com')).toBe('refused');
    expect(grantsLibraries('https://graph.microsoft.com/Files.ReadWrite.All openid')).toBe(true);
    expect(grantsLibraries('Files.ReadWrite')).toBe(false);
  });
});
