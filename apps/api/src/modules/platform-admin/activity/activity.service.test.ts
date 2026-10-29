import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ObjectStore } from '@tmanage/storage';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { PlatformAuditInput } from '../platform-admin.repository.js';
import type { PlatformAuditService } from '../platform-audit.service.js';
import type { ActionRow, ActivityRepository } from './activity.repository.js';
import { PlatformActivityService } from './activity.service.js';
import type { ActivityServiceDeps } from './activity.service.js';
import type { ExportJobRecord, ExportsRepository } from './exports.repository.js';

/** platform-admin v2 · PA-09 — C2 detail (tenant path, redaction, same request, audited view), C3, C6. */

const ORG = '0199aa00-0000-7000-8000-0000000000c1';
const EVENT = '0199aa00-0000-7000-8000-0000000000e1';
const SESSION = '0199aa00-0000-7000-8000-0000000000d1';
const SUPPORT = '0199aa00-0000-7000-8000-0000000000b1';
const JOB = '0199aa00-0000-7000-8000-0000000000f1';
const CONTEXT = { correlationId: 'corr-req', ip: '197.45.1.8', userAgent: 'Chrome' };

function actor(permissions: readonly string[]): PlatformAdminActor {
  return {
    account: {
      userId: '0199aa00-0000-7000-8000-0000000000a1',
      email: 'peter@tmanage.app',
      displayName: 'Peter',
      emailVerified: true,
      mfaEnabled: false,
    },
    sessionId: 'browser',
    stepUp: null,
    permissions: permissions as PlatformAdminActor['permissions'],
  };
}

const ROW: ActionRow = {
  id: EVENT,
  organizationId: ORG,
  organizationName: 'Nile Studio',
  organizationSlug: 'nile-studio',
  actorUserId: '0199aa00-0000-7000-8000-0000000000a1',
  actorEmail: 'peter@tmanage.app',
  actorName: 'Peter',
  effectiveActorUserId: '0199aa00-0000-7000-8000-0000000000a1',
  effectiveActorEmail: 'peter@tmanage.app',
  effectiveActorName: 'Peter',
  action: 'custom_role.updated',
  objectType: 'custom_role',
  objectId: 'role-1',
  result: 'allowed',
  correlationId: 'corr-1',
  supportSessionId: SUPPORT,
  ip: '197.45.1.8',
  userAgent: 'Chrome 130',
  createdAt: new Date('2026-10-28T14:01:47.000Z'),
};

function job(overrides: Partial<ExportJobRecord> = {}): ExportJobRecord {
  return {
    id: JOB,
    requestedBy: '0199aa00-0000-7000-8000-0000000000a1',
    requestedByEmail: 'peter@tmanage.app',
    requestedByName: 'Peter',
    scope: 'actions',
    filterJson: '{"organizationId":"x"}',
    status: 'queued',
    rowCount: null,
    objectKey: null,
    error: null,
    createdAt: new Date('2026-10-28T14:06:00.000Z'),
    finishedAt: null,
    expiresAt: null,
    now: new Date('2026-10-28T14:07:00.000Z'),
    ...overrides,
  };
}

function build(overrides: Partial<Record<string, unknown>> = {}) {
  const recorded: unknown[] = [];
  const audit = {
    record: vi.fn(async (input: unknown) => {
      recorded.push(input);
      return input;
    }),
  } as unknown as PlatformAuditService;
  const activity = {
    listActions: vi.fn(async () => [ROW]),
    actionTotals: vi.fn(async () => ({ total: 1, viaSupport: 1, denied: 0, errors: 0 })),
    actionDetail: vi.fn(async () => ({
      action: ROW,
      metadataJson: '{"role_id":"role-1","nested":{"bad":1}}',
      actorRole: 'member',
      changes: [
        { field: 'files.delete', before: 'off', after: 'on', redacted: false },
        { field: 'integration_token', before: 'secret', after: 'other', redacted: true },
      ],
      sameCorrelation: [
        { id: 'x', action: 'role.cache_refreshed', result: 'allowed', createdAt: new Date(0) },
      ],
    })),
    supportSession: vi.fn(async () => ({
      id: SUPPORT,
      reason: 'Ticket #812',
      startedAt: new Date('2026-10-28T13:40:00.000Z'),
      adminEmail: 'peter@tmanage.app',
    })),
    endSession: vi.fn(
      async (
        _id: string,
        auditOf: (owner: {
          userId: string;
          email: string;
          userAgent: string | null;
        }) => PlatformAuditInput,
      ) => {
        recorded.push(auditOf({ userId: 'omar', email: 'omar@x.co', userAgent: 'Safari' }));
        return { userId: 'omar', ended: true };
      },
    ),
    ...(overrides['activity'] as object),
  } as unknown as ActivityRepository;
  const exportsRepo = {
    create: vi.fn(async (input: { audit: PlatformAuditInput }) => {
      recorded.push(input.audit);
      return job();
    }),
    find: vi.fn(async () => job()),
    list: vi.fn(async () => [job()]),
    markDeleted: vi.fn(async (_id: string, input: PlatformAuditInput) => {
      recorded.push(input);
      return true;
    }),
    finishReady: vi.fn(async () => undefined),
    finishFailed: vi.fn(async () => undefined),
    ...(overrides['exports'] as object),
  } as unknown as ExportsRepository;
  const deps: ActivityServiceDeps = {
    admins: {} as ActivityServiceDeps['admins'],
    activity,
    exports: exportsRepo,
    supportSessions: {} as ActivityServiceDeps['supportSessions'],
    audit,
    allowlist: [],
    objectStore: (overrides['objectStore'] as ObjectStore | undefined) ?? null,
  };
  return { service: new PlatformActivityService(deps), recorded, activity, exportsRepo };
}

describe('C1 list', () => {
  it('hides IPs and devices without platform.activity.detail', async () => {
    const { service } = build();
    const view = await service.actions(actor(['platform.activity.view']), {}, CONTEXT);
    expect(view.showsOrigin).toBe(false);
    expect(view.actions[0]).toMatchObject({
      ip: null,
      userAgent: null,
      actionLabel: expect.any(String),
    });
    const detailed = await service.actions(
      actor(['platform.activity.view', 'platform.activity.detail']),
      {},
      CONTEXT,
    );
    expect(detailed.actions[0]?.ip).toBe('197.45.1.8');
  });
});

describe('C2 detail', () => {
  it('opens one organization’s event with before → after, redacted values marked, same request', async () => {
    const { service, activity } = build();
    const view = await service.actionDetail(
      actor(['platform.activity.detail']),
      ORG,
      EVENT,
      CONTEXT,
    );
    expect(activity.actionDetail).toHaveBeenCalledWith(ORG, EVENT, 'corr-req');
    expect(view.changes).toEqual([
      { field: 'files.delete', before: 'off', after: 'on', redacted: false },
      { field: 'integration_token', before: null, after: null, redacted: true },
    ]);
    expect(view.sameCorrelation).toHaveLength(1);
    expect(view.actorRole).toBe('platform_support');
    expect(view.supportSession?.reason).toBe('Ticket #812');
    // Unsafe metadata (a nested object) is not shown at all.
    expect(view.metadata).toEqual({});
  });

  it('is itself audited as platform.action_detail_viewed', async () => {
    const { service, recorded } = build();
    await service.actionDetail(actor(['platform.activity.detail']), ORG, EVENT, CONTEXT);
    expect(recorded[0]).toMatchObject({
      action: 'platform.action_detail_viewed',
      organizationId: ORG,
      targetId: ORG,
      reasonRequired: false,
      after: { eventId: EVENT, action: 'custom_role.updated' },
    });
  });

  it('answers 404 for an id from another organization (nothing found on its tenant path)', async () => {
    const { service, recorded } = build({ activity: { actionDetail: vi.fn(async () => null) } });
    await expect(
      service.actionDetail(actor(['platform.activity.detail']), ORG, EVENT, CONTEXT),
    ).rejects.toMatchObject({ status: 404 });
    expect(recorded).toEqual([]);
  });
});

describe('C3 end session', () => {
  it('needs a reason and records platform.session_ended', async () => {
    const { service, recorded } = build();
    await expect(
      service.endSession(actor(['platform.people.security']), SESSION, {}, CONTEXT),
    ).rejects.toMatchObject({ status: 400 });
    const done = await service.endSession(
      actor(['platform.people.security']),
      SESSION,
      { reason: 'IP with failed bursts' },
      CONTEXT,
    );
    expect(done).toEqual({ ended: true, userId: 'omar' });
    expect(recorded.at(-1)).toMatchObject({
      action: 'platform.session_ended',
      targetType: 'user',
      targetId: 'omar',
      reason: 'IP with failed bursts',
    });
  });
});

describe('C6 exports', () => {
  it('queues a job with its scope-filtered filter and logs the request', async () => {
    const { service, recorded, exportsRepo } = build();
    const view = await service.createExport(
      actor(['platform.activity.export']),
      {
        scope: 'actions',
        filter: { organizationId: 'x', body: 'drop me' },
        reason: 'Monthly review',
      },
      CONTEXT,
    );
    expect(view.status).toBe('queued');
    expect(exportsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'actions', filterJson: '{"organizationId":"x"}' }),
    );
    expect(recorded[0]).toMatchObject({
      action: 'platform.export_requested',
      targetType: 'export',
      reason: 'Monthly review',
    });
  });

  it('fails a sign-ins export honestly when no file storage is set up', async () => {
    const { service, exportsRepo } = build({ activity: { listSignIns: vi.fn(async () => []) } });
    await service.createExport(actor(['platform.activity.export']), { scope: 'sign-ins' }, CONTEXT);
    expect(exportsRepo.finishFailed).toHaveBeenCalled();
  });

  it('streams a ready file from the private zone, and refuses an expired one', async () => {
    const store = {
      openObject: vi.fn(async () => ({ sizeBytes: 3, stream: Readable.from(['a,b']) })),
    } as unknown as ObjectStore;
    const ready = job({
      status: 'ready',
      objectKey: `platform/exports/${JOB}/abc.csv`,
      expiresAt: new Date('2026-10-29T14:06:00.000Z'),
    });
    const { service } = build({ objectStore: store, exports: { find: vi.fn(async () => ready) } });
    const file = await service.download(JOB, CONTEXT);
    expect(file.fileName).toBe('tmanage-actions-2026-10-28.csv');
    expect(store.openObject).toHaveBeenCalledWith({ zone: 'private', objectKey: ready.objectKey });

    const expired = { ...ready, now: new Date('2026-10-29T15:00:00.000Z') };
    const later = build({ objectStore: store, exports: { find: vi.fn(async () => expired) } });
    await expect(later.service.download(JOB, CONTEXT)).rejects.toMatchObject({ status: 404 });
  });

  it('deletes by marking the job, with its audit row', async () => {
    const { service, recorded } = build();
    await expect(
      service.deleteExport(actor(['platform.activity.export']), JOB, {}, CONTEXT),
    ).resolves.toEqual({ deleted: true });
    expect(recorded.at(-1)).toMatchObject({ action: 'platform.export_deleted', targetId: JOB });
  });
});
