import { ApiError } from '../../common/http/errors.js';
import { describe, expect, it, vi } from 'vitest';
import { assertSafeAuditMetadata } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { DeliverablesService } from './deliverables.service.js';

/** 0211: send-for-approval is one unit (projection + approval + email event); a new version asks again. */
const ORG = 'org-1';
const ctx = { organizationId: ORG } as TenantContext;
const admin = {
  userId: 'u-1',
  organizationId: ORG,
  kind: 'internal',
  role: 'workspace_admin',
  membershipId: 'm-1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: ['p-1'],
  hasOrgWideScope: true,
} as Principal;
const deliverable = {
  id: 'd-1',
  projectId: 'p-1',
  title: 'Homepage',
  description: null,
  createdByUserId: 'u-1',
  createdAt: new Date(),
  updatedAt: new Date(),
};
const v2 = {
  id: 'v-2',
  deliverableId: 'd-1',
  versionNo: 2,
  contentHash: 'h'.repeat(64),
  fileAssetId: null,
  fileVersionId: null,
  note: null,
  createdByUserId: 'u-1',
  createdAt: new Date(),
};
const pending = {
  id: 'a-1',
  state: 'requested',
  version: 1,
  deliverableVersionId: 'v-1',
  projectId: 'p-1',
};

function build(sharingRefuses = false) {
  const db = {
    transaction: (_c: unknown, w: (tx: never) => unknown) => w({} as never),
    read: (_c: unknown, w: (tx: never) => unknown) => w({} as never),
  } as unknown as TenantDatabase;
  const repos = {
    deliverables: {
      requireById: vi.fn(async () => deliverable),
      findById: vi.fn(async (): Promise<object | null> => ({
        ...deliverable,
        deletedAt: new Date(),
      })),
      setDeleted: vi.fn(),
      create: vi.fn(async () => ({
        ...deliverable,
        description: null,
        createdByUserId: 'u-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      touch: vi.fn(),
      fileWithLatestVersion: vi.fn(async (): Promise<object | null> => null),
      approvalsFor: vi.fn(async () => [pending]),
      clientPeopleFor: vi.fn(async () => [
        {
          userId: 'c-1',
          displayName: 'Youssef',
          role: 'client_reviewer',
          clientOrganizationName: 'Atlas',
        },
      ]),
    },
    versions: {
      latestForDeliverable: vi.fn(async () => v2),
      findById: vi.fn(async (): Promise<object | null> => null),
      listForDeliverable: vi.fn(async () => [v2]),
      create: vi.fn(async (_t: unknown, _c: unknown, i: object) => ({
        ...i,
        id: 'v-3',
        createdAt: new Date(),
      })),
    },
    approvals: {
      findByVersion: vi.fn(async () => null),
      listByVersion: vi.fn(async (): Promise<readonly object[]> => []),
      open: vi.fn(async (_t: unknown, _c: unknown, _i: object) => ({
        id: 'a-2',
        state: 'requested',
        reviewerIds: ['c-1'],
      })),
      transition: vi.fn(),
    },
    projections: {
      findByVersion: vi.fn(async (): Promise<object | null> => null),
      listByProject: vi.fn(async (): Promise<readonly object[]> => []),
      publish: vi.fn(async (_t: unknown, _c: unknown, i: object) => ({
        ...i,
        id: 'cp-1',
        publishedAt: new Date('2026-11-15T10:00:00.000Z'),
      })),
    },
    outbox: { append: vi.fn() },
    projects: { findById: vi.fn(async () => ({ id: 'p-1', archivedAt: null })) },
    // Q3: the real metadata rule runs, so an unsafe key or value fails the test.
    audit: {
      record: vi.fn(async (_t: unknown, _c: unknown, input: { metadata: unknown }) => {
        assertSafeAuditMetadata(input.metadata);
      }),
    },
  };
  const service = new DeliverablesService(
    db,
    repos.deliverables as never,
    repos.versions as never,
    repos.approvals as never,
    repos.projections as never,
    repos.projects as never,
    repos.outbox as never,
    repos.audit as never,
    // FIX6 item 1: the sharing rule is unit-tested on its own; here every file may be shared.
    {
      policiesOn: () =>
        Promise.resolve({
          clientFiles: 'checked',
          teamDownloads: 'allow_labeled',
          scannerPresent: false,
        }),
      assertVersionFileShareable: () =>
        sharingRefuses
          ? Promise.reject(new ApiError(409, 'conflict', 'not shareable'))
          : Promise.resolve(),
    } as never,
  );
  return { service, ...repos };
}

describe('DeliverablesService (0211)', () => {
  it('FIX6 item 8: the owner deletes a deliverable (soft, audited); a member cannot', async () => {
    const { service, deliverables, audit } = build();
    deliverables.approvalsFor.mockResolvedValue([]);
    await service.remove(ctx, admin, 'd-1');
    expect(deliverables.setDeleted.mock.calls[0]?.[2]).toBe('d-1');
    expect(deliverables.setDeleted.mock.calls[0]?.[3]).toMatchObject({ byUserId: 'u-1' });
    expect(audit.record.mock.calls[0]?.[2]).toMatchObject({
      action: 'deliverable.deleted',
      metadata: { project_id: 'p-1' },
    });
    const member = { ...admin, role: 'member', hasOrgWideScope: false } as Principal;
    const second = build();
    await expect(second.service.remove(ctx, member, 'd-1')).rejects.toBeInstanceOf(ApiError);
    expect(second.deliverables.setDeleted).not.toHaveBeenCalled();
  });

  it('FIX6 item 8: a deliverable the client approved is never deleted', async () => {
    const { service, deliverables } = build();
    deliverables.approvalsFor.mockResolvedValue([{ ...pending, state: 'approved' }]);
    await expect(service.remove(ctx, admin, 'd-1')).rejects.toMatchObject({ status: 409 });
    expect(deliverables.setDeleted).not.toHaveBeenCalled();
  });

  it('FIX6 item 8: Undo restores a deleted deliverable, with the same permission', async () => {
    const { service, deliverables, audit } = build();
    await service.restore(ctx, admin, 'd-1');
    expect(deliverables.setDeleted.mock.calls[0]?.[3]).toBeNull();
    expect(audit.record.mock.calls[0]?.[2]).toMatchObject({ action: 'deliverable.restored' });
    const member = { ...admin, role: 'member', hasOrgWideScope: false } as Principal;
    const second = build();
    await expect(second.service.restore(ctx, member, 'd-1')).rejects.toBeInstanceOf(ApiError);
    expect(second.deliverables.setDeleted).not.toHaveBeenCalled();
  });

  it('UX-1: "Share with client" publishes the newest version to the portal with no approval and no e-mail', async () => {
    const { service, projections, approvals, outbox, audit } = build();
    const shared = await service.share(ctx, admin, 'd-1', 'v-2');
    expect(shared).toEqual({
      deliverableVersionId: 'v-2',
      sharedWithClientAt: '2026-11-15T10:00:00.000Z',
    });
    expect(projections.publish).toHaveBeenCalledOnce();
    expect(projections.publish.mock.calls[0]?.[2]).toMatchObject({
      deliverableId: 'd-1',
      deliverableVersionId: 'v-2',
    });
    expect(approvals.open).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
    expect(audit.record.mock.calls[0]?.[2]).toMatchObject({
      action: 'deliverable.shared_with_client',
      metadata: { project_id: 'p-1', deliverable_version_id: 'v-2' },
    });
  });

  it('UX-1: sharing needs deliverable.publish on the project; a reviewer without it publishes nothing', async () => {
    const { service, projections } = build();
    const viewer = { ...admin, role: 'member', hasOrgWideScope: false } as Principal;
    await expect(service.share(ctx, viewer, 'd-1', 'v-2')).rejects.toBeInstanceOf(ApiError);
    expect(projections.publish).not.toHaveBeenCalled();
  });

  it('UX-1: sharing refuses an older version and a file the sharing rule refuses, before publishing', async () => {
    const older = build();
    await expect(older.service.share(ctx, admin, 'd-1', 'v-unknown')).rejects.toMatchObject({
      status: 404,
    });
    expect(older.projections.publish).not.toHaveBeenCalled();
    const refused = build(true);
    await expect(refused.service.share(ctx, admin, 'd-1', 'v-2')).rejects.toMatchObject({
      status: 409,
    });
    expect(refused.projections.publish).not.toHaveBeenCalled();
  });

  it('UX-1: sharing a version already shared answers the first share and writes nothing new', async () => {
    const { service, projections, audit } = build();
    projections.findByVersion.mockResolvedValue({
      publishedAt: new Date('2026-11-14T09:00:00.000Z'),
    });
    const shared = await service.share(ctx, admin, 'd-1', 'v-2');
    expect(shared.sharedWithClientAt).toBe('2026-11-14T09:00:00.000Z');
    expect(projections.publish).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('UX-1: the deliverable says which versions the client can open (one source: the projections)', async () => {
    const { service, projections } = build();
    projections.listByProject.mockResolvedValue([
      {
        deliverableId: 'd-1',
        deliverableVersionId: 'v-2',
        publishedAt: new Date('2026-11-15T10:00:00.000Z'),
      },
      { deliverableId: 'd-other', deliverableVersionId: 'v-9', publishedAt: new Date() },
    ]);
    const detail = await service.detail(ctx, admin, 'd-1');
    expect(detail.sharedWithClient).toBe(true);
    expect(detail.versions[0]?.sharedWithClientAt).toBe('2026-11-15T10:00:00.000Z');
    projections.listByProject.mockResolvedValue([]);
    expect((await service.detail(ctx, admin, 'd-1')).sharedWithClient).toBe(false);
  });

  it('FIX6: a version takes a file the checks passed but no scanner judged (live has none)', async () => {
    const { service, deliverables, versions } = build();
    deliverables.fileWithLatestVersion.mockResolvedValue({
      asset: {
        projectId: 'p-1',
        purpose: 'deliverable',
        objectId: null,
        status: 'scanning',
        deletedAt: null,
      },
      version: {
        id: 'fv-1',
        contentHash: 'c',
        detectedMimeType: 'application/pdf',
        scanVerdict: 'unscanned',
        trustZone: 'quarantine',
      },
    });
    await service.addVersion(ctx, admin, 'd-1', { fileAssetId: 'f-1', note: null });
    expect(versions.create).toHaveBeenCalledOnce();
  });

  it('FIX6: a version never takes a file the checks blocked', async () => {
    const { service, deliverables, versions } = build();
    deliverables.fileWithLatestVersion.mockResolvedValue({
      asset: {
        projectId: 'p-1',
        purpose: 'deliverable',
        objectId: null,
        status: 'rejected',
        deletedAt: null,
      },
      version: {
        id: 'fv-1',
        contentHash: 'c',
        detectedMimeType: 'application/pdf',
        scanVerdict: null,
        trustZone: 'quarantine',
      },
    });
    await expect(
      service.addVersion(ctx, admin, 'd-1', { fileAssetId: 'f-1', note: null }),
    ).rejects.toMatchObject({ status: 422 });
    expect(versions.create).not.toHaveBeenCalled();
  });

  it('FIX6: sending refuses a version whose file may not reach the client, before publishing', async () => {
    const { service, projections, approvals } = build(true);
    await expect(
      service.send(ctx, admin, 'd-1', 'v-2', {
        approverIds: ['c-1'],
        dueDate: null,
        checkNote: null,
        notify: true,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(projections.publish).not.toHaveBeenCalled();
    expect(approvals.open).not.toHaveBeenCalled();
  });

  it('sends the newest version: publishes, opens the approval for the picked approvers, emits approval.requested.v1', async () => {
    const { service, projections, approvals, outbox } = build();
    const sent = await service.send(ctx, admin, 'd-1', 'v-2', {
      approverIds: ['c-1'],
      dueDate: '2026-08-18',
      checkNote: 'Brand feel',
      notify: true,
    });
    expect(sent).toMatchObject({ approvalId: 'a-2', deliverableVersionId: 'v-2' });
    expect(projections.publish).toHaveBeenCalledOnce();
    expect(approvals.open.mock.calls[0]?.[2]).toMatchObject({
      reviewerIds: ['c-1'],
      contentHash: v2.contentHash,
    });
    expect(outbox.append.mock.calls[0]?.[2]).toMatchObject({
      type: 'approval.requested.v1',
      payload: { reviewerUserIds: ['c-1'] },
    });
  });

  it('refuses an approver without approval authority on the project', async () => {
    const { service } = build();
    await expect(
      service.send(ctx, admin, 'd-1', 'v-2', {
        approverIds: ['stranger'],
        dueDate: null,
        checkNote: null,
        notify: true,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('a new version invalidates the approval still pending on the older one and numbers itself next', async () => {
    const { service, approvals, versions } = build();
    const created = await service.addVersion(ctx, admin, 'd-1', {
      fileAssetId: null,
      note: 'Bigger logo',
    });
    expect(approvals.transition.mock.calls[0]?.slice(2, 5)).toEqual(['a-1', 1, 'invalidated']);
    expect(created.versionNo).toBe(3);
    expect(versions.create).toHaveBeenCalledOnce();
  });

  it('Q3: audits creating a deliverable with ids only', async () => {
    const { service, audit } = build();
    await service.create(ctx, admin, { projectId: 'p-1', title: 'Homepage', description: 'x' });
    expect(audit.record.mock.calls[0]?.[2]).toEqual({
      action: 'deliverable.created',
      objectId: 'd-1',
      result: 'allowed',
      metadata: { project_id: 'p-1' },
    });
  });

  it('Q3: audits a new version and the approval it cancelled', async () => {
    const { service, audit } = build();
    await service.addVersion(ctx, admin, 'd-1', { fileAssetId: null, note: 'Bigger logo' });
    const actions = audit.record.mock.calls.map((call) => call[2] as unknown as { action: string });
    expect(actions.map((a) => a.action)).toEqual([
      'approval.invalidated',
      'deliverable.version_added',
    ]);
    expect(audit.record.mock.calls[0]?.[2]).toMatchObject({
      objectId: 'a-1',
      metadata: { deliverable_id: 'd-1', deliverable_version_id: 'v-1', project_id: 'p-1' },
    });
    expect(audit.record.mock.calls[1]?.[2]).toMatchObject({
      objectId: 'd-1',
      metadata: { version_no: 3, file_asset_id: null, deliverable_version_id: 'v-3' },
    });
  });

  it('Q3: audits a send with the approval, the reviewer count and the due date', async () => {
    const { service, audit } = build();
    await service.send(ctx, admin, 'd-1', 'v-2', {
      approverIds: ['c-1', 'c-1'],
      dueDate: '2026-08-18',
      checkNote: 'Brand feel',
      notify: false,
    });
    expect(audit.record.mock.calls[0]?.[2]).toEqual({
      action: 'deliverable.sent_for_approval',
      objectId: 'd-1',
      result: 'allowed',
      metadata: {
        project_id: 'p-1',
        deliverable_version_id: 'v-2',
        approval_id: 'a-2',
        reviewer_count: 1,
        due_date: '2026-08-18',
      },
    });
  });
});
