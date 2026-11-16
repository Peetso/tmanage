import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { parseSeedKeys } from '@tmanage/config';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { StorageConnectionRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import { createSeedCipher } from '../identity/seed-cipher.js';
import {
  DriveNoAccessError,
  newDriveFlow,
  type DriveTransport,
} from '../google-drive/google-drive.google.js';
import type { GoogleDriveRepository } from '../google-drive/google-drive.repository.js';
import { GoogleDriveService, tokenBinding } from '../google-drive/google-drive.service.js';
import { googleRootOwner, oneDriveRootOwner, toRootOwnerView } from './root-owner.js';
import type { HandoverCandidateRow } from './storage-handover.repository.js';
import { StorageHandoverService, type StorageHandoverStore } from './storage-handover.service.js';
import { StorageHoldsHook } from './storage-holds.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const LEAVER = '01890000-0000-7000-8000-00000000a001';
const ADMIN = '01890000-0000-7000-8000-00000000a002';
const MEMBER = '01890000-0000-7000-8000-00000000a003';
const CIPHER = createSeedCipher(parseSeedKeys(`1:${Buffer.alloc(32, 0x33).toString('base64url')}`));

const ctx = (userId = LEAVER, organizationId = ORG_A) =>
  ({ organizationId, userId, correlationId: 'c-1' }) as unknown as TenantContext;
const principal = (role: string, organizationId = ORG_A) =>
  ({
    userId: LEAVER,
    organizationId,
    kind: 'internal',
    role,
    membershipId: 'm-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  }) as unknown as Principal;
/** The workspace requires no two-step sign-in of anyone (slice 2's check, off here). */
const noGap = async () => false;
const database = {
  read: (_c: TenantContext, work: (runner: unknown) => Promise<unknown>) => work({}),
  transaction: (_c: TenantContext, work: (runner: unknown) => Promise<unknown>) => work({}),
} as unknown as TenantDatabase;

function connection(patch: Partial<StorageConnectionRow> = {}): StorageConnectionRow {
  return {
    id: 'conn-1',
    organizationId: ORG_A,
    provider: 'google_drive',
    storageMode: 'google_drive',
    status: 'connected',
    accountEmail: 'leaver@example.com',
    refreshTokenEnc: CIPHER.encrypt('old-refresh', tokenBinding(ORG_A)),
    rootFolderId: 'root_folder_1',
    sharedDriveId: null,
    sharedDriveName: null,
    rootOwnerKind: 'personal',
    connectedByUserId: LEAVER,
    handoverToUserId: null,
    ...patch,
  } as StorageConnectionRow;
}

describe('root owner detection', () => {
  it('tells a company-owned root from a personal one, and steers only the personal one', () => {
    expect(googleRootOwner('0AShared')).toBe('shared_drive');
    expect(googleRootOwner(null)).toBe('personal');
    expect(oneDriveRootOwner('documentLibrary')).toBe('sharepoint_library');
    expect(oneDriveRootOwner('business')).toBe('personal');
    expect(oneDriveRootOwner('personal')).toBe('personal');
    expect(oneDriveRootOwner('other')).toBe('unknown');
    expect(toRootOwnerView(connection(), LEAVER, true)).toMatchObject({
      companyOwned: false,
      recommendCompanyRoot: true,
      connectedByMe: true,
    });
    expect(
      toRootOwnerView(connection({ rootOwnerKind: 'shared_drive' }), ADMIN, true),
    ).toMatchObject({ companyOwned: true, recommendCompanyRoot: false, connectedByMe: false });
  });
});

/** Members per tenant: a lookup outside the acting tenant resolves nothing. */
function store(row = connection()) {
  const members: Record<string, HandoverCandidateRow[]> = {
    [ORG_A]: [
      { userId: LEAVER, displayName: 'Ali', role: 'owner' },
      { userId: ADMIN, displayName: 'Mona', role: 'org_admin' },
      { userId: MEMBER, displayName: 'Sami', role: 'member' },
    ],
    [ORG_B]: [{ userId: ADMIN, displayName: 'Mona', role: 'org_admin' }],
  };
  const fake = {
    findConnection: vi.fn(async (_r: unknown, c: TenantContext) =>
      c.organizationId === row.organizationId ? row : undefined,
    ),
    listActiveMembers: vi.fn(
      async (_r: unknown, c: TenantContext) => members[c.organizationId] ?? [],
    ),
    findActiveMember: vi.fn(
      async (_r: unknown, c: TenantContext, userId: string) =>
        members[c.organizationId]?.find((m) => m.userId === userId) ?? null,
    ),
    setHandoverTarget: vi.fn(async () => undefined),
  };
  return fake satisfies StorageHandoverStore;
}

describe('hand-over request', () => {
  it('is refused for a non-admin before anything is read or written', async () => {
    const fake = store();
    const service = new StorageHandoverService(database, { record: vi.fn() }, fake, noGap);
    await expect(
      service.request(ctx(), principal('member'), { provider: 'google_drive', toUserId: ADMIN }),
    ).rejects.toMatchObject({ status: 403 });
    expect(fake.findConnection).not.toHaveBeenCalled();
    expect(fake.setHandoverTarget).not.toHaveBeenCalled();
  });

  it('refuses a target who is not an admin, or who is only in another workspace', async () => {
    const audit = { record: vi.fn() };
    const fake = store(connection({ organizationId: ORG_B }));
    const service = new StorageHandoverService(database, audit, fake, noGap);
    // ORG_B's connection and admin do not resolve from ORG_A.
    await expect(
      service.request(ctx(), principal('owner'), { provider: 'google_drive', toUserId: ADMIN }),
    ).rejects.toMatchObject({ status: 409 });
    const own = store();
    const inA = new StorageHandoverService(database, audit, own, noGap);
    await expect(
      inA.request(ctx(), principal('owner'), { provider: 'google_drive', toUserId: MEMBER }),
    ).rejects.toMatchObject({ status: 400 });
    own.findActiveMember.mockResolvedValue(null);
    await expect(
      inA.request(ctx(), principal('owner'), { provider: 'google_drive', toUserId: ADMIN }),
    ).rejects.toMatchObject({ status: 400 });
    expect(own.setHandoverTarget).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('names the admin and writes the audit entry; the list offers only admins', async () => {
    const audit = { record: vi.fn() };
    const fake = store();
    const service = new StorageHandoverService(database, audit, fake, noGap);
    const view = await service.request(ctx(), principal('owner'), {
      provider: 'google_drive',
      toUserId: ADMIN,
    });
    expect(view).toEqual({
      provider: 'google_drive',
      toUserId: ADMIN,
      toDisplayName: 'Mona',
      status: 'pending',
    });
    expect(fake.setHandoverTarget).toHaveBeenCalledWith({}, expect.anything(), 'conn-1', ADMIN);
    expect(audit.record).toHaveBeenCalledWith(
      {},
      expect.anything(),
      expect.objectContaining({
        action: 'storage_connection.handover_requested',
        metadata: { provider: 'google_drive', from_user_id: LEAVER, to_user_id: ADMIN },
      }),
    );
    const list = await service.targets(ctx(), principal('owner'), 'google_drive');
    expect(list.targets).toEqual([{ userId: ADMIN, displayName: 'Mona' }]);
  });
});

describe('hand-over completion (Google)', () => {
  function drive(row: StorageConnectionRow, getFile: DriveTransport['getFile']) {
    let current = row;
    const repository = {
      findConnection: vi.fn(async () => current),
      saveConnected: vi.fn(),
      update: vi.fn(async (_r: unknown, _c: unknown, _id: string, patch: object) => {
        current = { ...current, ...patch };
      }),
    };
    const transport = {
      exchangeCode: vi.fn(async () => ({
        accessToken: 'new-at',
        refreshToken: 'new-refresh',
        email: 'mona@example.com',
      })),
      getFile,
      revoke: vi.fn(async () => undefined),
      ensureFolder: vi.fn(),
    } as unknown as DriveTransport;
    const audit = { record: vi.fn(async () => ({})) };
    const service = new GoogleDriveService({
      database,
      audit: audit as unknown as AuditService,
      transport,
      cipher: CIPHER,
      config: { clientId: 'cid', clientSecret: 's', pickerApiKey: null, projectNumber: null },
      apiPublicUrl: 'https://tmanage.example.com',
      repository: repository as unknown as GoogleDriveRepository,
      storageModes: { effective: async () => 'google_drive', switchTo: async () => undefined },
    });
    return { service, repository, transport, audit, current: () => current };
  }
  const flow = () => newDriveFlow({ organizationId: ORG_A, organizationSlug: 'n', userId: ADMIN });

  it('swaps the token, keeps the root, revokes the old token and audits the hand-over', async () => {
    const { service, repository, transport, audit, current } = drive(
      connection({ handoverToUserId: ADMIN }),
      vi.fn(async () => ({}) as never),
    );
    const started = flow();
    await service.completeConnect(ctx(ADMIN), started, { code: 'c', state: started.state });
    expect(repository.saveConnected).not.toHaveBeenCalled();
    expect(current()).toMatchObject({
      rootFolderId: 'root_folder_1',
      connectedByUserId: ADMIN,
      handoverToUserId: null,
    });
    expect(CIPHER.decrypt(current().refreshTokenEnc as string, tokenBinding(ORG_A))).toBe(
      'new-refresh',
    );
    expect(transport.revoke).toHaveBeenCalledWith('old-refresh');
    expect(audit.record).toHaveBeenCalledWith(
      {},
      expect.anything(),
      expect.objectContaining({
        action: 'storage_connection.handover',
        metadata: { provider: 'google_drive', from_user_id: LEAVER, to_user_id: ADMIN },
      }),
    );
  });

  it('changes nothing when the new account cannot open the root', async () => {
    const { service, repository, audit } = drive(
      connection({ handoverToUserId: ADMIN }),
      vi.fn(async () => {
        throw new DriveNoAccessError('no');
      }),
    );
    const started = flow();
    await expect(
      service.completeConnect(ctx(ADMIN), started, { code: 'c', state: started.state }),
    ).rejects.toMatchObject({ status: 409 });
    expect(repository.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('51-17 slice 2: two-step sign-in and the leave announcement', () => {
  it('refuses a target the workspace two-step rule would refuse, before any write', async () => {
    const audit = { record: vi.fn() };
    const fake = store();
    const gap = vi.fn(async () => true);
    const service = new StorageHandoverService(database, audit, fake, gap);
    await expect(
      service.request(ctx(), principal('owner'), { provider: 'google_drive', toUserId: ADMIN }),
    ).rejects.toMatchObject({
      status: 409,
      details: [{ field: 'toUserId', message: 'two_step_required' }],
    });
    expect(gap).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_A }),
      expect.objectContaining({ userId: ADMIN, role: 'org_admin' }),
    );
    expect(fake.setHandoverTarget).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('reads holds in the acting tenant only and keeps the two cloud providers', async () => {
    const listHeldBy = vi.fn(async (_r: unknown, c: TenantContext) =>
      c.organizationId === ORG_A
        ? [
            { id: 'conn-1', provider: 'google_drive' },
            { id: 'conn-x', provider: 'tmanage' },
          ]
        : [],
    );
    const hook = new StorageHoldsHook({ append: vi.fn() }, { listHeldBy });
    expect(await hook.heldBy({} as never, ctx(), LEAVER)).toEqual([
      { connectionId: 'conn-1', provider: 'google_drive' },
    ]);
    expect(await hook.heldBy({} as never, ctx(LEAVER, ORG_B), LEAVER)).toEqual([]);
    expect(listHeldBy).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ organizationId: ORG_A }),
      LEAVER,
    );
  });

  it('announces each held connection once per leave, keyed by connection and leave', async () => {
    const append = vi.fn(async () => 'event-1');
    const hook = new StorageHoldsHook({ append } as unknown as OutboxEventsRepository, {
      listHeldBy: vi.fn(),
    });
    await hook.announceLeft(
      {} as never,
      ctx(),
      [{ connectionId: 'conn-1', provider: 'onedrive' }],
      'm-1:2',
    );
    expect(append).toHaveBeenCalledWith({}, expect.anything(), {
      type: 'storage_connection.root_at_risk.v1',
      aggregateId: 'conn-1',
      payload: expect.objectContaining({
        organizationId: ORG_A,
        reason: 'holder_offboarded',
        idempotencyKey: 'conn-1:holder_offboarded:m-1:2',
      }),
    });
  });
});
