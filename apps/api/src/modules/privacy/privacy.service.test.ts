import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { ObjectStore } from '@tmanage/storage';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PrivacyDeletionRequestRow, PrivacyExportRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { mayDownload, PrivacyService } from './privacy.service.js';
import type { PrivacyRepository } from './privacy.repository.js';
import { confirmsCompanyName, exportStateOf } from './privacy-policy.js';

/**
 * D5 (Figma F5) — the data-rights rules over fakes: owner-only company acts, the typed-name
 * confirmation, one active deletion at a time with a 30-day grace period, the last-owner guard, and
 * the download gate (who, expiry, readiness, the owner's scan policy).
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OWNER = '00000000-0000-4000-8000-0000000000c1';
const MEMBER = '00000000-0000-4000-8000-0000000000c2';
const NOW = new Date('2026-10-25T10:42:00.000Z');
const context = { organizationId: ORG, correlationId: 'c' } as unknown as TenantContext;

function principal(userId: string, role: Principal['role']): Principal {
  return {
    userId,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: `${userId.slice(0, -2)}e1`,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  } as Principal;
}

function exportRow(overrides: Partial<PrivacyExportRow>): PrivacyExportRow {
  return {
    id: '00000000-0000-4000-8000-0000000000d1',
    organizationId: ORG,
    kind: 'company',
    subjectUserId: null,
    requestedByUserId: OWNER,
    status: 'ready',
    progressPercent: 100,
    objectKey: `tenant/${ORG}/privacy-export/x/archive.json.gz`,
    sizeBytes: 3,
    scanStatus: 'clean',
    failureCode: null,
    claimedAt: NOW,
    requestedAt: NOW,
    completedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 7 * 86_400_000),
    purgedAt: null,
    version: 3,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface Fixture {
  readonly orgName?: string;
  readonly activeDeletion?: PrivacyDeletionRequestRow;
  readonly owners?: number;
  readonly exportRow?: PrivacyExportRow;
  readonly policy?: 'block' | 'allow_labeled';
}

function build(fixture: Fixture = {}) {
  const inserted: Record<string, unknown>[] = [];
  const audits: string[] = [];
  const events: string[] = [];
  const database = {
    read: (_c: unknown, fn: (r: unknown) => unknown) => fn({}),
    transaction: (_c: unknown, fn: (r: unknown) => unknown) => fn({}),
  } as unknown as TenantDatabase;
  const repository = {
    organization: () => Promise.resolve({ id: ORG, name: fixture.orgName ?? 'Northstar Studio' }),
    activeMembers: () => Promise.resolve([]),
    displayNames: () => Promise.resolve(new Map([[OWNER, 'Maya Hassan']])),
    listExports: () => Promise.resolve([]),
    activeDeletion: () => Promise.resolve(fixture.activeDeletion),
    lockOrganization: () => Promise.resolve(true),
    activeOwnerCount: () => Promise.resolve(fixture.owners ?? 2),
    insertDeletion: (_r: unknown, _c: unknown, input: Record<string, unknown>) => {
      inserted.push(input);
      return Promise.resolve('00000000-0000-4000-8000-0000000000f1');
    },
    insertExport: (_r: unknown, _c: unknown, input: Record<string, unknown>) => {
      inserted.push(input);
      return Promise.resolve('00000000-0000-4000-8000-0000000000f2');
    },
    findExport: () => Promise.resolve(fixture.exportRow),
    cancelDeletion: () => Promise.resolve(true),
  } as unknown as PrivacyRepository;
  const audit = {
    record: (_r: unknown, _c: unknown, input: { action: string }) => {
      audits.push(input.action);
      return Promise.resolve({});
    },
    recordDenial: (_c: unknown, action: string) => {
      audits.push(`denied:${action}`);
      return Promise.resolve(true);
    },
  } as unknown as AuditService;
  const outbox = {
    append: (_r: unknown, _c: unknown, input: { type: string }) => {
      events.push(input.type);
      return Promise.resolve('e');
    },
  } as unknown as OutboxEventsRepository;
  const store = {
    openObject: () =>
      Promise.resolve({ sizeBytes: 3, stream: Readable.from([Buffer.from('abc')]) }),
  } as unknown as ObjectStore;
  const service = new PrivacyService(
    database,
    store,
    audit,
    outbox,
    { kind: 'engine' },
    undefined,
    repository,
    () => NOW,
    () => Promise.resolve(fixture.policy ?? 'allow_labeled'),
  );
  return { service, inserted, audits, events };
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('Privacy — owner-only company acts', () => {
  it('refuses an admin the company export, the deletion and the page itself', async () => {
    const { service, inserted } = build();
    const admin = principal(MEMBER, 'org_admin');
    expect((await refusal(service.overview(context, admin))).status).toBe(403);
    expect(
      (await refusal(service.requestOwnerExport(context, admin, { kind: 'company' }))).status,
    ).toBe(403);
    expect(
      (
        await refusal(
          service.requestCompanyDeletion(context, admin, { confirmName: 'Northstar Studio' }),
        )
      ).status,
    ).toBe(403);
    expect(inserted).toEqual([]);
  });
});

describe('Privacy — deleting the company', () => {
  it('refuses a name that is not the company name, with nothing written', async () => {
    const { service, inserted } = build();
    const error = await refusal(
      service.requestCompanyDeletion(context, principal(OWNER, 'owner'), {
        confirmName: 'Northstar',
      }),
    );
    expect(error.status).toBe(400);
    expect(inserted).toEqual([]);
  });

  it('schedules the deletion 30 days out, audited and announced', async () => {
    const { service, inserted, audits, events } = build();
    await service.requestCompanyDeletion(context, principal(OWNER, 'owner'), {
      confirmName: '  Northstar Studio ',
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.['kind']).toBe('company');
    expect((inserted[0]?.['scheduledFor'] as Date).toISOString()).toBe('2026-11-24T10:42:00.000Z');
    expect(audits).toContain('privacy_deletion.requested');
    expect(events).toContain('privacy_deletion.changed.v1');
  });

  it('refuses a second request while one is scheduled', async () => {
    const active = { id: 'r', kind: 'company', status: 'scheduled' } as PrivacyDeletionRequestRow;
    const { service, inserted } = build({ activeDeletion: active });
    const error = await refusal(
      service.requestCompanyDeletion(context, principal(OWNER, 'owner'), {
        confirmName: 'Northstar Studio',
      }),
    );
    expect(error.status).toBe(409);
    expect(inserted).toEqual([]);
  });
});

describe('Privacy — deleting my account', () => {
  it('keeps the only owner from deleting their account', async () => {
    const { service, inserted } = build({ owners: 1 });
    const error = await refusal(service.requestMyDeletion(context, principal(OWNER, 'owner')));
    expect(error.status).toBe(409);
    expect(error.details?.[0]?.message).toBe('last_owner');
    expect(inserted).toEqual([]);
  });

  it('lets a member ask, scheduled for themselves', async () => {
    const { service, inserted } = build();
    await service.requestMyDeletion(context, principal(MEMBER, 'member'));
    expect(inserted[0]).toMatchObject({ kind: 'account', subjectUserId: MEMBER });
  });
});

describe('Privacy — downloading an archive', () => {
  it('serves a ready, unexpired archive to an owner, audited', async () => {
    const { service, audits } = build({ exportRow: exportRow({}) });
    const download = await service.download(context, principal(OWNER, 'owner'), 'x', 'owner');
    expect(download.scanStatus).toBe('clean');
    expect(download.fileName).toBe('tmanage-export-company-2026-10-25.json.gz');
    expect(audits).toContain('privacy_export.downloaded');
  });

  it('answers an expired link with 409 expired', async () => {
    const row = exportRow({ expiresAt: new Date(NOW.getTime() - 1) });
    const { service } = build({ exportRow: row });
    const error = await refusal(service.download(context, principal(OWNER, 'owner'), 'x', 'owner'));
    expect(error.status).toBe(409);
    expect(error.details?.[0]?.message).toBe('expired');
  });

  it('holds an unscanned archive back when the owner chose block', async () => {
    const row = exportRow({ scanStatus: 'not_scanned' });
    const { service } = build({ exportRow: row, policy: 'block' });
    const error = await refusal(service.download(context, principal(OWNER, 'owner'), 'x', 'owner'));
    expect(error.details?.[0]?.message).toBe('scan_required_by_policy');
  });

  it("never hands a member someone else's archive", async () => {
    const row = exportRow({ kind: 'member', subjectUserId: OWNER, requestedByUserId: OWNER });
    const { service, audits } = build({ exportRow: row });
    const error = await refusal(
      service.download(context, principal(MEMBER, 'member'), 'x', 'self'),
    );
    expect(error.status).toBe(404);
    expect(audits).toContain('denied:privacy_export.downloaded');
  });
});

describe('Privacy — pure rules', () => {
  it('lets the requesting owner, not another owner, have a member export', () => {
    const row = { kind: 'member' as const, requestedByUserId: OWNER, subjectUserId: MEMBER };
    expect(mayDownload(row, { userId: OWNER, role: 'owner' }, 'owner')).toBe(true);
    expect(mayDownload(row, { userId: MEMBER, role: 'owner' }, 'owner')).toBe(false);
    expect(mayDownload(row, { userId: MEMBER, role: 'member' }, 'self')).toBe(false);
  });

  it('reads a ready archive past its link date as expired', () => {
    expect(exportStateOf({ status: 'ready', expiresAt: new Date(NOW.getTime() - 1) }, NOW)).toBe(
      'expired',
    );
    expect(exportStateOf({ status: 'preparing', expiresAt: null }, NOW)).toBe('preparing');
  });

  it('confirms only the exact company name', () => {
    expect(confirmsCompanyName('Northstar Studio', 'Northstar Studio')).toBe(true);
    expect(confirmsCompanyName('northstar studio', 'Northstar Studio')).toBe(false);
    expect(confirmsCompanyName(undefined, 'Northstar Studio')).toBe(false);
  });
});
