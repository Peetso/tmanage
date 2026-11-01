import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  AttachmentVersionRow,
  FileAssetRow,
  FileReviewDecisionRow,
  ProjectRow,
} from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { AttachmentVersionsRepository } from './attachment-versions.repository.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import type { FileClientRelation } from './file-client-relation.js';
import type { FileDownloadService, ResolvedFile } from './file-download.service.js';
import {
  FileReviewDecisionsController,
  PortalFileReviewDecisionsController,
} from './file-review-decisions.controller.js';
import type {
  FileReviewDecisionsRepository,
  InsertFileReviewDecisionInput,
} from './file-review-decisions.repository.js';
import { FileReviewDecisionsService, stateOf } from './file-review-decisions.service.js';
import type { ReviewMentionCandidatesRepository } from './review-mention-candidates.repository.js';
import type { ReviewThreadsRepository, VersionThreadCounts } from './review-threads.repository.js';

/**
 * R4 slice 11 — the database-free proof of Approve / Request changes on plain files: both
 * controllers over the real service, fake reads, and the **real** `authorize`. The append-only
 * and note triggers are 0269's, proved by the DB suite.
 */

const ORG = '01890000-0000-7000-8000-00000000000a';
const PROJECT = '01890000-0000-7000-8000-000000000101';
const ROOT = '01890000-0000-7000-8000-000000000301';
const V2 = '01890000-0000-7000-8000-000000000302';
const OTHER = '01890000-0000-7000-8000-000000000303';
const DELIVERABLE_FILE = '01890000-0000-7000-8000-000000000304';
const USER = '01890000-0000-7000-8000-000000000001';
const CLIENT_USER = '01890000-0000-7000-8000-000000000002';
const CLIENT_ORG = '01890000-0000-7000-8000-0000000000c1';

const context = {
  organizationId: ORG,
  membershipId: 'm-staff',
} as unknown as TenantContext;
const clientContext = {
  organizationId: ORG,
  membershipId: 'm-client',
} as unknown as TenantContext;

function staff(over: Partial<Principal> = {}): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: 'm-staff',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT],
    hasOrgWideScope: false,
    ...over,
  } as Principal;
}

function client(over: Partial<Principal> = {}): Principal {
  return staff({
    userId: CLIENT_USER,
    kind: 'client',
    role: 'client_reviewer',
    membershipId: 'm-client',
    clientOrganizationId: CLIENT_ORG,
    ...over,
  } as Partial<Principal>);
}

function asset(id: string, over: Partial<FileAssetRow> = {}): FileAssetRow {
  return {
    id,
    organizationId: ORG,
    projectId: PROJECT,
    clientOrganizationId: CLIENT_ORG,
    ownerUserId: USER,
    name: `${id.slice(-3)}.png`,
    purpose: 'request_attachment',
    audience: 'client_visible',
    status: 'ready',
    deletedAt: null,
    createdAt: new Date('2026-10-01T10:00:00.000Z'),
    ...over,
  } as unknown as FileAssetRow;
}

function harness(options: { archived?: boolean } = {}) {
  const files = [asset(ROOT), asset(V2), asset(OTHER), asset(DELIVERABLE_FILE)];
  const byId = new Map(files.map((file) => [file.id, file]));
  const chain: AttachmentVersionRow[] = [
    {
      id: 'av-2',
      organizationId: ORG,
      projectId: PROJECT,
      rootFileAssetId: ROOT,
      fileAssetId: V2,
      versionNo: 2,
      note: null,
      createdByUserId: USER,
      createdAt: new Date('2026-10-02T10:00:00.000Z'),
    },
  ];
  const decided: FileReviewDecisionRow[] = [];
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const audited: string[] = [];
  let clock = Date.parse('2026-10-30T14:05:00.000Z');

  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const downloads = {
    resolve: async (_c: unknown, _p: unknown, id: string): Promise<ResolvedFile> => {
      const found = byId.get(id);
      if (!found) throw new ApiError(404, 'not_found', 'Not found');
      return {
        asset: found,
        version: { id: `fv-${id}` },
        project: { archivedAt: options.archived ? new Date() : null } as unknown as ProjectRow,
        access: { state: 'servable' },
      } as unknown as ResolvedFile;
    },
  } as unknown as FileDownloadService;
  const audit = {
    record: async (_r: unknown, _c: unknown, input: { action: string }) => {
      audited.push(input.action);
    },
  } as unknown as AuditService;
  const outbox = {
    append: async (_r: unknown, _c: unknown, event: { type: string; payload: never }) => {
      events.push(event);
    },
  } as unknown as OutboxEventsRepository;
  const decisions = {
    insert: async (_r: unknown, _c: TenantContext, input: InsertFileReviewDecisionInput) => {
      clock += 60_000;
      const row = {
        ...input,
        id: `d-${decided.length + 1}`,
        organizationId: ORG,
        createdAt: new Date(clock),
      } as FileReviewDecisionRow;
      decided.push(row);
      return row;
    },
    listForRoot: async (_r: unknown, _c: unknown, root: string) =>
      decided
        .filter((row) => row.rootFileAssetId === root)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    deliverableVersionFor: async (_r: unknown, _c: unknown, id: string) =>
      id === DELIVERABLE_FILE ? { id: 'dv-1', deliverableId: 'del-1' } : null,
  } as unknown as FileReviewDecisionsRepository;
  const assets = {
    findById: async (_r: unknown, _c: unknown, id: string) => byId.get(id) ?? null,
    findLatestVersion: async (_r: unknown, _c: unknown, id: string) => ({ id: `fv-${id}` }),
  } as unknown as FileAssetsRepository;
  const versions = {
    findInvolving: async (_r: unknown, _c: unknown, id: string) =>
      chain.find((row) => row.fileAssetId === id || row.rootFileAssetId === id) ?? null,
    listForRoot: async (_r: unknown, _c: unknown, root: string) =>
      chain.filter((row) => row.rootFileAssetId === root),
  } as unknown as AttachmentVersionsRepository;
  const counts: Record<string, VersionThreadCounts[]> = {
    all: [
      { fileVersionId: `fv-${V2}`, open: 3, resolved: 0, carried: 2 },
      { fileVersionId: `fv-${ROOT}`, open: 1, resolved: 4, carried: 0 },
    ],
    client: [{ fileVersionId: `fv-${V2}`, open: 1, resolved: 0, carried: 1 }],
  };
  const threads = {
    countsByVersion: async (_r: unknown, _c: unknown, _root: string, audiences: string[]) =>
      audiences.includes('internal') ? counts['all'] : counts['client'],
  } as unknown as ReviewThreadsRepository;
  const people = {
    peopleByMembership: async (_r: unknown, _c: unknown, ids: readonly string[]) =>
      ids.map((id) => ({
        membershipId: id,
        userId: id === 'm-client' ? CLIENT_USER : USER,
        displayName: id === 'm-client' ? 'Youssef Kamal' : 'Lina Samir',
        kind: id === 'm-client' ? 'client' : 'internal',
      })),
  } as unknown as ReviewMentionCandidatesRepository;
  const relation = {
    reach: async (_r: unknown, _c: unknown, _p: unknown, member: FileAssetRow) => ({
      via: 'request',
      audience: member.audience,
    }),
  } as unknown as FileClientRelation;

  const service = new FileReviewDecisionsService(
    database,
    downloads,
    audit,
    outbox,
    decisions,
    assets,
    versions,
    threads,
    people,
    relation,
  );
  return {
    studio: new FileReviewDecisionsController(service),
    portal: new PortalFileReviewDecisionsController(service),
    decided,
    events,
    audited,
  };
}

async function errorOf(work: () => Promise<unknown>): Promise<ApiError> {
  try {
    await work();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected the call to throw');
}

describe('FileReviewDecisionsService (R4 slice 11)', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('records an approval on the version, audited, with an ids-only event', async () => {
    const view = await h.studio.record(context, staff(), V2, { decision: 'approved' });
    expect(h.decided).toHaveLength(1);
    expect(h.decided[0]).toMatchObject({
      rootFileAssetId: ROOT,
      fileAssetId: V2,
      fileVersionId: `fv-${V2}`,
      principalKind: 'internal',
      decidedByMembershipId: 'm-staff',
    });
    expect(h.audited).toEqual(['review.decision_recorded']);
    expect(h.events).toEqual([
      {
        type: 'review.decision_recorded.v1',
        aggregateId: V2,
        payload: {
          decisionId: 'd-1',
          rootFileAssetId: ROOT,
          fileAssetId: V2,
          projectId: PROJECT,
          decision: 'approved',
          byUserId: USER,
          principalKind: 'internal',
          versionNo: 2,
        },
      },
    ]);
    expect(view.versions.map((v) => [v.versionNo, v.state])).toEqual([
      [2, 'approved'],
      [1, 'in_review'],
    ]);
    expect(view.versions[0]?.latestDecision?.decidedBy.displayName).toBe('Lina Samir');
  });

  it('needs a note to request changes (400), and keeps every decision (append-only history)', async () => {
    const refused = await errorOf(() =>
      h.studio.record(context, staff(), V2, { decision: 'changes_requested', note: '  ' }),
    );
    expect(refused.status).toBe(400);
    await h.portal.record(clientContext, client(), V2, {
      decision: 'changes_requested',
      note: 'Use the brand lime',
    });
    const view = await h.studio.record(context, staff(), V2, { decision: 'approved' });
    expect(view.history.map((d) => [d.decision, d.versionNo, d.decidedBy.kind])).toEqual([
      ['approved', 2, 'internal'],
      ['changes_requested', 2, 'client'],
    ]);
    expect(view.history[1]?.note).toBe('Use the brand lime');
    expect(view.versions[0]?.state).toBe('approved');
  });

  it('decides an older version named in the body, but only inside the same chain', async () => {
    const view = await h.studio.record(context, staff(), V2, {
      fileAssetId: ROOT,
      decision: 'approved',
    });
    expect(view.versions.find((v) => v.versionNo === 1)?.state).toBe('approved');
    const outside = await errorOf(() =>
      h.studio.record(context, staff(), V2, { fileAssetId: OTHER, decision: 'approved' }),
    );
    expect(outside.status).toBe(400);
  });

  it('answers 409 use_deliverable_approval for a deliverable version, naming it', async () => {
    const error = await errorOf(() =>
      h.studio.record(context, staff(), DELIVERABLE_FILE, { decision: 'approved' }),
    );
    expect(error.status).toBe(409);
    expect(error.details).toEqual([
      { field: 'deliverableId', message: 'del-1' },
      { field: 'deliverableVersionId', message: 'dv-1' },
    ]);
    expect(h.decided).toHaveLength(0);
  });

  it('refuses a Client Viewer, an archived project, a wrong door and an unknown decision', async () => {
    expect(
      (
        await errorOf(() =>
          h.portal.record(clientContext, client({ role: 'client_viewer' }), V2, {
            decision: 'approved',
          }),
        )
      ).status,
    ).toBe(403);
    const archived = harness({ archived: true });
    expect(
      (await errorOf(() => archived.studio.record(context, staff(), V2, { decision: 'approved' })))
        .status,
    ).toBe(403);
    expect(
      (await errorOf(() => h.studio.record(context, client(), V2, { decision: 'approved' })))
        .status,
    ).toBe(403);
    expect(
      (await errorOf(() => h.studio.record(context, staff(), V2, { decision: 'approve' }))).status,
    ).toBe(400);
    expect(h.decided).toHaveLength(0);
  });

  it('shows a client only client decisions and client-visible comment counts', async () => {
    await h.studio.record(context, staff(), V2, {
      decision: 'changes_requested',
      note: 'internal call',
    });
    const view = await h.portal.list(clientContext, client(), V2);
    expect(view.history).toEqual([]);
    expect(view.versions[0]).toMatchObject({
      versionNo: 2,
      openThreads: 1,
      carriedThreads: 1,
      state: 'in_review',
      latestDecision: null,
    });
    const staffView = await h.studio.list(context, staff(), V2);
    expect(staffView.versions[0]).toMatchObject({
      openThreads: 3,
      carriedThreads: 2,
      state: 'changes_requested',
    });
  });

  it('states: a decision wins; else in review with open or client-visible comments; else shared', () => {
    expect(stateOf(null, 0, false)).toBe('shared');
    expect(stateOf(null, 2, false)).toBe('in_review');
    expect(stateOf(null, 0, true)).toBe('in_review');
  });
});
