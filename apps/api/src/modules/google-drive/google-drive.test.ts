import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { parseSeedKeys } from '@tmanage/config';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { StorageConnectionRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import { createSeedCipher } from '../identity/seed-cipher.js';
import { callbackTarget, parseSettings } from './google-drive.controller.js';
import {
  DRIVE_FLOW_COOKIE,
  DriveGrantRevokedError,
  driveConfigFrom,
  driveFolderName,
  driveQueryLiteral,
  newDriveFlow,
  openDriveFlow,
  sealDriveFlow,
  type DriveTransport,
} from './google-drive.google.js';
import type { GoogleDriveRepository } from './google-drive.repository.js';
import { GoogleDriveService, safeDriveLink, tokenBinding } from './google-drive.service.js';

const SECRET = 'session-secret-for-tests-only-0123456789';
const CIPHER = createSeedCipher(parseSeedKeys(`1:${Buffer.alloc(32, 0x33).toString('base64url')}`));
const CONFIG = {
  clientId: 'cid',
  clientSecret: 'csecret',
  pickerApiKey: null,
  projectNumber: null,
};
const ORG_A = 'org-a';
const ORG_B = 'org-b';

function ctx(organizationId = ORG_A, userId = 'user-1'): TenantContext {
  return { organizationId, userId, correlationId: 'c-1' } as unknown as TenantContext;
}

const PROJECT_ON = '01890000-0000-7000-8000-000000000101';
const PROJECT_OFF = '01890000-0000-7000-8000-000000000102';

function internalPrincipal(role: string, hasOrgWideScope: boolean): Principal {
  return {
    userId: 'user-1',
    organizationId: ORG_A,
    kind: 'internal',
    role,
    membershipId: 'm-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT_ON],
    hasOrgWideScope,
  } as unknown as Principal;
}

/** The company owner: org-wide scope and `org.manage` (the Storage screen's "Change folder"). */
function orgAdmin(): Principal {
  return internalPrincipal('owner', true);
}

const database = {
  read: (_c: TenantContext, work: (runner: unknown) => Promise<unknown>) => work({}),
  transaction: (_c: TenantContext, work: (runner: unknown) => Promise<unknown>) => work({}),
} as unknown as TenantDatabase;

function fakeRepository(initial?: Partial<StorageConnectionRow>) {
  let row: StorageConnectionRow | undefined = initial
    ? ({
        id: 'conn-1',
        organizationId: ORG_A,
        provider: 'google_drive',
        storageMode: 'tmanage',
        status: 'connected',
        accountEmail: 'owner@example.com',
        refreshTokenEnc: null,
        rootFolderId: 'root_folder_1',
        sharedDriveId: null,
        sharedDriveName: null,
        lastErrorCode: null,
        ...initial,
      } as StorageConnectionRow)
    : undefined;
  const repository = {
    findConnection: vi.fn(async () => row),
    saveConnected: vi.fn(async (_r: unknown, _c: unknown, input: Record<string, unknown>) => {
      row = {
        ...(row ?? { id: 'conn-1', storageMode: 'tmanage' }),
        ...input,
        status: 'connected',
      } as unknown as StorageConnectionRow;
    }),
    update: vi.fn(async (_r: unknown, _c: unknown, _id: string, patch: object) => {
      row = { ...(row as StorageConnectionRow), ...patch };
    }),
  };
  return { repository, current: () => row };
}

function transport(overrides: Partial<DriveTransport> = {}): DriveTransport {
  return {
    exchangeCode: vi.fn(async () => ({
      accessToken: 'at',
      refreshToken: 'plain-refresh-token',
      email: 'owner@example.com',
    })),
    refreshAccessToken: vi.fn(async () => 'fresh-access'),
    revoke: vi.fn(async () => undefined),
    ensureFolder: vi.fn(async () => 'root_folder_1'),
    getFile: vi.fn(),
    listChildren: vi.fn(async () => ({ files: [], nextPageToken: null })),
    startUpload: vi.fn(),
    ...overrides,
  };
}

function service(
  repository: object,
  google: DriveTransport,
  audit = { record: vi.fn(async () => ({})) },
) {
  return new GoogleDriveService({
    database,
    audit: audit as unknown as AuditService,
    transport: google,
    cipher: CIPHER,
    config: CONFIG,
    apiPublicUrl: 'https://tmanage.example.com',
    webPublicUrl: 'https://tmanage.example.com',
    uploadMaxBytes: 1000,
    repository: repository as unknown as GoogleDriveRepository,
    workItems: { findById: vi.fn(async () => null) },
  });
}

describe('configuration comes only from the environment', () => {
  it('is off without a client id and secret, and prefers the Drive-specific names', () => {
    expect(driveConfigFrom({})).toBeNull();
    expect(driveConfigFrom({ GOOGLE_DRIVE_CLIENT_ID: 'x' })).toBeNull();
    expect(driveConfigFrom({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' })?.clientId).toBe(
      'a',
    );
    expect(
      driveConfigFrom({
        GOOGLE_CLIENT_ID: 'a',
        GOOGLE_CLIENT_SECRET: 'b',
        GOOGLE_DRIVE_CLIENT_ID: 'd',
        GOOGLE_DRIVE_CLIENT_SECRET: 'e',
      }),
    ).toMatchObject({ clientId: 'd', clientSecret: 'e', pickerApiKey: null });
  });
});

describe('the signed flow cookie', () => {
  const flow = newDriveFlow({ organizationId: ORG_A, organizationSlug: 'north', userId: 'u1' });

  it('round-trips, and refuses a forged, foreign-secret or expired value', () => {
    const sealed = sealDriveFlow(flow, SECRET);
    expect(openDriveFlow(sealed, SECRET)).toEqual(flow);
    const [payload, signature] = sealed.split('.');
    const forged = Buffer.from(JSON.stringify({ ...flow, organizationId: ORG_B })).toString(
      'base64url',
    );
    expect(openDriveFlow(`${forged}.${signature}`, SECRET)).toBeUndefined();
    expect(openDriveFlow(`${payload}.${signature}`, 'another-secret')).toBeUndefined();
    expect(openDriveFlow(sealed, SECRET, flow.expiresAt + 1)).toBeUndefined();
  });

  it('the callback forwards code and state in the fragment, to the flow organization only', () => {
    const cookie = `${DRIVE_FLOW_COOKIE}=${sealDriveFlow(flow, SECRET)}`;
    const options = { sessionSecret: SECRET, webPublicUrl: 'https://tmanage.example.com/' };
    const target = callbackTarget(options, cookie, 'the-code', 'the-state');
    expect(target).toBe(
      'https://tmanage.example.com/north/admin/storage#drive=complete&code=the-code&state=the-state',
    );
    expect(target.split('#')[0]).not.toContain('the-code');
    expect(callbackTarget(options, undefined, 'the-code', 'x')).toBe(
      'https://tmanage.example.com/',
    );
    expect(callbackTarget(options, cookie, undefined, 'x')).toMatch(/#drive=error$/);
  });
});

describe('connecting', () => {
  it('refuses a flow from another organization, person or state before calling Google', async () => {
    const { repository } = fakeRepository();
    const google = transport();
    const drive = service(repository, google);
    const flow = newDriveFlow({
      organizationId: ORG_A,
      organizationSlug: 'north',
      userId: 'user-1',
    });
    for (const [context, state] of [
      [ctx(ORG_B), flow.state],
      [ctx(ORG_A, 'user-2'), flow.state],
      [ctx(ORG_A), 'wrong-state'],
    ] as const) {
      await expect(
        drive.completeConnect(context, flow, { code: 'c', state }),
      ).rejects.toMatchObject({ status: 400 });
    }
    await expect(
      drive.completeConnect(ctx(), undefined, { code: 'c', state: flow.state }),
    ).rejects.toMatchObject({ status: 400 });
    expect(google.exchangeCode).not.toHaveBeenCalled();
  });

  it('stores the refresh token only encrypted, bound to the organization, and audits', async () => {
    const { repository, current } = fakeRepository();
    const audit = { record: vi.fn(async () => ({})) };
    const drive = service(repository, transport(), audit);
    const flow = newDriveFlow({
      organizationId: ORG_A,
      organizationSlug: 'north',
      userId: 'user-1',
    });

    const view = await drive.completeConnect(ctx(), flow, { code: 'c', state: flow.state });

    const stored = current()?.refreshTokenEnc as string;
    expect(stored).not.toContain('plain-refresh-token');
    expect(CIPHER.decrypt(stored, tokenBinding(ORG_A))).toBe('plain-refresh-token');
    expect(() => CIPHER.decrypt(stored, tokenBinding(ORG_B))).toThrow();
    expect(view.googleDrive).toMatchObject({
      status: 'connected',
      accountEmail: 'owner@example.com',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: 'storage_connection.connected' }),
    );
  });
});

describe('a refused grant and the status view', () => {
  it('moves the connection to error and answers 409 when Google refuses the token', async () => {
    const { repository, current } = fakeRepository({
      refreshTokenEnc: CIPHER.encrypt('rt', tokenBinding(ORG_A)),
    });
    const google = transport({
      refreshAccessToken: vi.fn(async () => {
        throw new DriveGrantRevokedError('revoked');
      }),
    });
    await expect(
      service(repository, google).pickerSession(ctx(), orgAdmin()),
    ).rejects.toMatchObject({
      status: 409,
    });
    const configured = new GoogleDriveService({
      database,
      audit: { record: vi.fn() } as unknown as AuditService,
      transport: google,
      cipher: CIPHER,
      config: { ...CONFIG, pickerApiKey: 'k' },
      apiPublicUrl: 'https://x',
      webPublicUrl: 'https://x',
      uploadMaxBytes: 1,
      repository: repository as unknown as GoogleDriveRepository,
    });
    await expect(configured.pickerSession(ctx(), orgAdmin())).rejects.toMatchObject({
      status: 409,
    });
    expect(current()).toMatchObject({ status: 'error', lastErrorCode: 'revoked' });
    expect((await configured.status(ctx(), true)).googleDrive.status).toBe('error');
  });

  it('shows the account email only to people who manage the organization', async () => {
    const { repository } = fakeRepository({ refreshTokenEnc: 'x' });
    const drive = service(repository, transport());
    expect((await drive.status(ctx(), false)).googleDrive.accountEmail).toBeNull();
    expect((await drive.status(ctx(), true)).googleDrive.accountEmail).toBe('owner@example.com');
  });

  it('says "not configured" without the Google client and refuses to connect', async () => {
    const { repository } = fakeRepository();
    const drive = new GoogleDriveService({
      database,
      audit: { record: vi.fn() } as unknown as AuditService,
      transport: transport(),
      cipher: CIPHER,
      config: null,
      apiPublicUrl: 'https://x',
      webPublicUrl: 'https://x',
      uploadMaxBytes: 1,
      repository: repository as unknown as GoogleDriveRepository,
    });
    expect((await drive.status(ctx(), true)).configured).toBe(false);
    expect(() => drive.startConnect(ctx(), 'north')).toThrow(/not set up/);
  });
});

describe('attachments stay inside the tenant', () => {
  it('a work item outside the tenant (or unreadable) is a 404 before Google is asked', async () => {
    const { repository } = fakeRepository({
      refreshTokenEnc: CIPHER.encrypt('rt', tokenBinding(ORG_A)),
    });
    const google = transport();
    const principal = { role: 'member' } as unknown as Principal;
    await expect(
      service(repository, google).attach(ctx(), principal, 'item-elsewhere', 'file_12345'),
    ).rejects.toMatchObject({ status: 404 });
    expect(google.getFile).not.toHaveBeenCalled();
  });
});

describe('pure helpers', () => {
  it('makes safe folder names and escapes Drive query literals', () => {
    expect(driveFolderName('  Q3 / launch\u0000 plan  ', 'Project')).toBe('Q3 launch plan');
    expect(driveFolderName(' / ', 'Work item')).toBe('Work item');
    expect(driveQueryLiteral("it's \\ here")).toBe("'it\\'s \\\\ here'");
  });

  it('keeps only Google https links', () => {
    expect(safeDriveLink('https://drive.google.com/file/d/1/view')).not.toBeNull();
    expect(safeDriveLink('javascript:alert(1)')).toBeNull();
    expect(safeDriveLink('https://evil.example/drive.google.com')).toBeNull();
  });

  it('validates settings bodies', () => {
    expect(parseSettings({ storageMode: 'google_drive' })).toEqual({ storageMode: 'google_drive' });
    expect(parseSettings({ location: { kind: 'folder', folderId: 'abcde12345' } })).toEqual({
      location: { kind: 'folder', folderId: 'abcde12345' },
    });
    expect(() => parseSettings({ storageMode: 's3' })).toThrow();
    expect(() => parseSettings({ location: { kind: 'folder', folderId: "x' or 1=1" } })).toThrow();
    expect(() => parseSettings({})).toThrow();
  });
});

describe('NV10: the picker token needs the target project relation', () => {
  function pickerService() {
    const { repository } = fakeRepository({
      refreshTokenEnc: CIPHER.encrypt('rt', tokenBinding(ORG_A)),
    });
    const google = transport();
    const drive = new GoogleDriveService({
      database,
      audit: { record: vi.fn() } as unknown as AuditService,
      transport: google,
      cipher: CIPHER,
      config: { ...CONFIG, pickerApiKey: 'k' },
      apiPublicUrl: 'https://x',
      webPublicUrl: 'https://x',
      uploadMaxBytes: 1,
      repository: repository as unknown as GoogleDriveRepository,
      projects: {
        findById: vi.fn(async (_r: unknown, _c: unknown, id: string) =>
          id === PROJECT_ON || id === PROJECT_OFF
            ? ({ id, organizationId: ORG_A, archivedAt: null } as never)
            : null,
        ),
      },
    });
    return { drive, google };
  }

  it('refuses a guest, even on its own project, before any token is minted', async () => {
    const { drive, google } = pickerService();
    await expect(
      drive.pickerSession(ctx(), internalPrincipal('guest', false), PROJECT_ON),
    ).rejects.toMatchObject({ status: 403 });
    expect(google.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('refuses a member off the target project, and a member with no target', async () => {
    const { drive, google } = pickerService();
    const member = internalPrincipal('member', false);
    await expect(drive.pickerSession(ctx(), member, PROJECT_OFF)).rejects.toMatchObject({
      status: 403,
    });
    await expect(drive.pickerSession(ctx(), member)).rejects.toMatchObject({ status: 403 });
    expect(google.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('refuses a client principal', async () => {
    const { drive } = pickerService();
    const client = {
      ...internalPrincipal('client_member', false),
      kind: 'client',
      clientOrganizationId: 'c-1',
    } as unknown as Principal;
    await expect(drive.pickerSession(ctx(), client, PROJECT_ON)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('answers a member on the target project with no token, and an org admin with one', async () => {
    const { drive, google } = pickerService();
    const onProject = await drive.pickerSession(
      ctx(),
      internalPrincipal('member', false),
      PROJECT_ON,
    );
    expect(onProject).toEqual({ mode: 'scoped', projectId: PROJECT_ON });
    expect(google.refreshAccessToken).not.toHaveBeenCalled();
    const admin = await drive.pickerSession(ctx(), orgAdmin());
    expect(admin).toMatchObject({
      mode: 'google',
      accessToken: 'fresh-access',
      rootFolderId: 'root_folder_1',
    });
  });
});
