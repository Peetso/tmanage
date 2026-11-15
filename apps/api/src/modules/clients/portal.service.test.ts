import { ClientFileSharing } from '../files/client-file-sharing.js';
import type { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { findForbiddenClientFields } from '@tmanage/domain';
import type { ReviewThreadsRepository } from '../files/review-threads.repository.js';
import { PortalService, progressOf } from './portal.service.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { WorkItemsRepository } from '../work/work-items.repository.js';
import type { ClientProjectionsRepository } from '../approvals/client-projections.repository.js';
import type { FileAssetsRepository } from '../files/file-assets.repository.js';
import type {
  CreateProjectUpdateInput,
  ListProjectUpdatesOptions,
  ProjectUpdatesRepository,
} from './project-updates.repository.js';
import type { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  ClientProjectionPayload,
  ClientProjectionRow,
  FileAssetRow,
  FileVersionRow,
  ProjectRow,
  ProjectUpdateRow,
  WorkItemRow,
} from '../../common/database/schema.js';

/**
 * R07 — the portal must not stop before accessible records.
 *
 * The regression these two cases pin is *filtering after limiting*: the service fetched one
 * repository page of 50 rows and only then applied `mayRead`. A client whose only accessible
 * row sat past the first page therefore received an empty list, even with far fewer than 50
 * rows of their own. The fix walks pages until it has a full page of *readable* rows, so both
 * cases below pass now and fail against the old single-page order of operations.
 *
 * The repository relation check (`authorize()` rule 10) is exercised for real — the fakes only
 * stand in for the database and the keyset query, returning `id`-ordered pages exactly as the
 * scoped repositories do.
 */

const ORG = 'org-under-test';
const CLIENT_ORG = 'client-org-under-test';

/** A client viewer whose single shared project is `readableProjectId`. */
function clientPrincipal(readableProjectId: string): Principal {
  return {
    userId: 'user-1',
    organizationId: ORG,
    kind: 'client',
    role: 'client_viewer',
    membershipId: 'membership-1',
    membershipStatus: 'active',
    clientOrganizationId: CLIENT_ORG,
    projectIds: [readableProjectId],
    hasOrgWideScope: false,
  };
}

/** A fake database whose `read` simply runs the unit of work with an ignored runner. */
function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    read: <T>(_context: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
  } as unknown as TenantDatabase;
}

const context = {} as TenantContext;

/** A keyset page: rows with `id > after`, ascending by `id`, capped at `limit`. */
function page<T extends { id: string }>(
  all: readonly T[],
  after: string | undefined,
  limit: number,
): T[] {
  return [...all]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .filter((row) => after === undefined || row.id > after)
    .slice(0, limit);
}

function projectRow(id: string): ProjectRow {
  return {
    id,
    name: `Project ${id}`,
    status: 'active',
    committedAt: null,
    forecastAt: null,
  } as unknown as ProjectRow;
}

function workItemRow(id: string, projectId: string): WorkItemRow {
  return {
    id,
    projectId,
    title: `Item ${id}`,
    audience: 'client_visible',
    state: 'in_progress',
    dueAt: null,
    updatedAt: new Date('2026-09-13T00:00:00.000Z'),
  } as unknown as WorkItemRow;
}

/** Ids that sort in creation order: 'p-000' < 'p-001' < ... < 'p-059'. */
function paddedId(prefix: string, index: number): string {
  return `${prefix}-${String(index).padStart(3, '0')}`;
}

describe('PortalService.projectsFor (R07)', () => {
  it('returns an accessible project that sits past the first repository page', async () => {
    // 60 tenant projects; the client can read exactly one, at index 55 — the 56th row, which
    // no single 50-row page can reach.
    const readableIndex = 55;
    const readableId = paddedId('p', readableIndex);
    const projects: ProjectRow[] = Array.from({ length: 60 }, (_v, i) =>
      projectRow(paddedId('p', i)),
    );

    const projectsRepo = {
      list: (_runner: never, _ctx: TenantContext, options: { after?: string; limit?: number }) =>
        Promise.resolve(page(projects, options.after, options.limit ?? 50)),
    } as unknown as ProjectsRepository;

    const service = new PortalService(
      fakeDatabase(),
      projectsRepo,
      {} as unknown as WorkItemsRepository,
    );

    const result = await service.projectsFor(context, clientPrincipal(readableId));

    expect(result.map((p) => p.id)).toEqual([readableId]);
  });
});

describe('PortalService.workItemsFor (R07)', () => {
  it('returns client work in a readable project hidden behind a full page of unreadable rows', async () => {
    const readableProjectId = 'project-readable';
    const unreadableProjectId = 'project-unreadable';
    const readableIndex = 55;
    const readableItemId = paddedId('w', readableIndex);

    // 60 client-visible work items — audience passes the query for all of them — but only the
    // one at index 55 lives in a project the client may read.
    const items: WorkItemRow[] = Array.from({ length: 60 }, (_v, i) =>
      workItemRow(paddedId('w', i), i === readableIndex ? readableProjectId : unreadableProjectId),
    );

    const workItemsRepo = {
      list: (
        _runner: never,
        _ctx: TenantContext,
        options: { after?: string; limit?: number; audiences?: readonly string[] },
      ) => {
        // The service must always pass the client audience allowlist.
        expect(options.audiences).toEqual(['client_visible', 'client_action_required']);
        return Promise.resolve(page(items, options.after, options.limit ?? 50));
      },
    } as unknown as WorkItemsRepository;

    const service = new PortalService(
      fakeDatabase(),
      {} as unknown as ProjectsRepository,
      workItemsRepo,
    );

    const result = await service.workItemsFor(context, clientPrincipal(readableProjectId));

    expect(result.map((w) => w.id)).toEqual([readableItemId]);
  });
});

/**
 * The client-facing progress projection (R09 review, finding R08).
 *
 * `progressOf` collapses the internal lifecycle to the three things a client is told, and the
 * one trap is that `client_action_required` is an *audience*, not a state, and it is not
 * cleared when the work finishes. A completed item that still carries it must read as `done`,
 * never as `waiting_on_you` — the portal must not ask a client to act on finished work. This
 * pins every state/audience combination the portal can produce.
 *
 * The real service reads these rows against a live server in
 * `apps/api/test/client-002-portal.db.test.ts`; here we prove the pure mapping.
 */

const rowWith = (state: string, audience: WorkItemRow['audience']): WorkItemRow =>
  ({ state, audience }) as unknown as WorkItemRow;

// The audiences a client row can ever carry — `internal` is filtered out in the query.
const CLIENT_AUDIENCES: readonly WorkItemRow['audience'][] = [
  'client_visible',
  'client_action_required',
];

const TERMINAL_STATES = ['done', 'archived'] as const;
const OPEN_STATES = ['backlog', 'ready', 'in_progress', 'blocked', 'internal_review'] as const;

describe('progressOf', () => {
  it('reads a terminal state as done regardless of the action audience', () => {
    for (const state of TERMINAL_STATES) {
      for (const audience of CLIENT_AUDIENCES) {
        expect(progressOf(rowWith(state, audience)), `${state}/${audience}`).toBe('done');
      }
    }
  });

  it('never leaves finished work awaiting the client (the R08 regression)', () => {
    // A done item that still carries the action audience is the exact combination the review
    // reproduced returning `waiting_on_you`. Terminal state must win.
    expect(progressOf(rowWith('done', 'client_action_required'))).toBe('done');
    expect(progressOf(rowWith('archived', 'client_action_required'))).toBe('done');
  });

  it('promotes only an open action-required item to waiting_on_you', () => {
    for (const state of OPEN_STATES) {
      expect(progressOf(rowWith(state, 'client_action_required')), state).toBe('waiting_on_you');
    }
  });

  it('reads every other open state as in_progress', () => {
    for (const state of OPEN_STATES) {
      expect(progressOf(rowWith(state, 'client_visible')), state).toBe('in_progress');
    }
  });
});

/**
 * x114 — the client portal's deliverables and files reads.
 *
 * Two properties matter and both are proved over fakes with the **real** `authorize()` inside
 * `mayRead`: a client sees only the published, x97-allowlisted projection of a deliverable in a
 * project shared with them and only files scoped to their own client organization; anything they
 * cannot see — another client's project, an unpublished or unknown deliverable, a caller with no
 * client organization — is a `404`, never a 500 and never a leak (FAST-PROTOCOL Known trap).
 */

const READABLE_PROJECT = 'project-readable';
const OTHER_PROJECT = 'project-not-shared';
const DELIVERABLE = 'deliverable-1';

/** The full x97 allowlist — the only content keys a deliverable view may carry (12 §1). */
const PROJECTION_ALLOWLIST = [
  'title',
  'summary',
  'milestoneState',
  'forecastDate',
  'publishedRisk',
  'decision',
  'approvedContacts',
] as const;

/** The identity keys the portal adds for navigation — none is an internal record field. */
const DELIVERABLE_IDENTITY_KEYS = ['id', 'deliverableId', 'publishedAt'] as const;

function projectionPayload(): ClientProjectionPayload {
  return {
    title: 'Homepage redesign',
    summary: 'The first cut of the new homepage.',
    milestoneState: 'in_review',
    forecastDate: '2026-10-01',
    publishedRisk: 'Copy is still being finalised.',
    decision: null,
    approvedContacts: ['Dana at the studio'],
  };
}

function projectionRow(
  deliverableId: string,
  projectId: string,
  overrides: Partial<ClientProjectionRow> = {},
): ClientProjectionRow {
  return {
    id: `cp-${deliverableId}`,
    organizationId: ORG,
    projectId,
    deliverableId,
    deliverableVersionId: `dv-${deliverableId}`,
    contentHash: 'a'.repeat(64),
    projection: projectionPayload(),
    publishedByUserId: 'staff-1',
    publishedAt: new Date('2026-09-14T00:00:00.000Z'),
    ...overrides,
  } as ClientProjectionRow;
}

function fileAsset(id: string, overrides: Partial<FileAssetRow> = {}): FileAssetRow {
  return {
    id,
    organizationId: ORG,
    projectId: READABLE_PROJECT,
    clientOrganizationId: CLIENT_ORG,
    ownerUserId: 'staff-1',
    name: `${id}.pdf`,
    purpose: 'deliverable',
    objectId: DELIVERABLE,
    audience: 'client_visible',
    status: 'ready',
    rejectionCode: null,
    scanClaimedAt: null,
    purgedAt: null,
    version: 1,
    createdAt: new Date('2026-09-14T00:00:00.000Z'),
    updatedAt: new Date('2026-09-15T00:00:00.000Z'),
    ...overrides,
  } as FileAssetRow;
}

function fileVersion(fileAssetId: string, overrides: Partial<FileVersionRow> = {}): FileVersionRow {
  return {
    id: `fv-${fileAssetId}`,
    organizationId: ORG,
    fileAssetId,
    versionNo: 1,
    objectKey: 'private/secret-key-never-shown',
    sizeBytes: 2048,
    declaredMimeType: 'application/pdf',
    detectedMimeType: 'application/pdf',
    contentHash: 'b'.repeat(64),
    scanVerdict: 'clean',
    scannedAt: new Date('2026-09-14T01:00:00.000Z'),
    scanner: 'test',
    trustZone: 'private',
    etag: 'etag-1',
    createdAt: new Date('2026-09-14T00:00:00.000Z'),
    ...overrides,
  } as FileVersionRow;
}

function fakeProjections(rows: readonly ClientProjectionRow[]): ClientProjectionsRepository {
  return {
    listByProject: (_r: never, _c: TenantContext, projectId: string) =>
      Promise.resolve(rows.filter((row) => row.projectId === projectId)),
    findLatestByDeliverable: (_r: never, _c: TenantContext, deliverableId: string) =>
      Promise.resolve(rows.find((row) => row.deliverableId === deliverableId) ?? null),
  } as unknown as ClientProjectionsRepository;
}

function fakeFiles(
  rows: readonly { asset: FileAssetRow; version: FileVersionRow | null }[],
  onQuery?: (input: { deliverableId: string; clientOrganizationId: string | null }) => void,
): FileAssetsRepository {
  return {
    listClientVisibleForDeliverable: (
      _r: never,
      _c: TenantContext,
      input: { deliverableId: string; clientOrganizationId: string | null },
    ) => {
      onQuery?.(input);
      return Promise.resolve(rows);
    },
  } as unknown as FileAssetsRepository;
}

describe('PortalService.deliverablesFor (x114)', () => {
  it('returns only the x97-allowlisted projection fields for a project the client can read', async () => {
    const service = new PortalService(
      fakeDatabase(),
      {} as unknown as ProjectsRepository,
      {} as unknown as WorkItemsRepository,
      fakeProjections([projectionRow(DELIVERABLE, READABLE_PROJECT)]),
      fakeFiles([]),
    );

    const result = await service.deliverablesFor(
      context,
      clientPrincipal(READABLE_PROJECT),
      READABLE_PROJECT,
    );

    expect(result).toHaveLength(1);
    const view = result[0];
    if (!view) throw new Error('expected one deliverable');
    // Projection discipline: every content key is on the allowlist, no field is outside it, and
    // no forbidden client field (objectKey, cost, ownerUserId's kin, …) appears anywhere.
    expect(Object.keys(view).sort()).toEqual(
      [...PROJECTION_ALLOWLIST, ...DELIVERABLE_IDENTITY_KEYS].sort(),
    );
    expect(findForbiddenClientFields(view)).toEqual([]);
    expect(view).toMatchObject({
      id: 'dv-deliverable-1',
      deliverableId: DELIVERABLE,
      title: 'Homepage redesign',
      approvedContacts: ['Dana at the studio'],
    });
  });

  it('404s for a project the client is not on (client of another org), reading no rows', async () => {
    let listed = false;
    const projections = {
      listByProject: () => {
        listed = true;
        return Promise.resolve([]);
      },
      findLatestByDeliverable: () => Promise.resolve(null),
    } as unknown as ClientProjectionsRepository;

    const service = new PortalService(
      fakeDatabase(),
      {} as unknown as ProjectsRepository,
      {} as unknown as WorkItemsRepository,
      projections,
      fakeFiles([]),
    );

    // The client's only shared project is READABLE_PROJECT; asking for OTHER_PROJECT is a probe.
    await expect(
      service.deliverablesFor(context, clientPrincipal(READABLE_PROJECT), OTHER_PROJECT),
    ).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);
    expect(listed).toBe(false);
  });

  it('shows no unpublished deliverable — an empty list, not an error', async () => {
    const service = new PortalService(
      fakeDatabase(),
      {} as unknown as ProjectsRepository,
      {} as unknown as WorkItemsRepository,
      fakeProjections([]),
      fakeFiles([]),
    );

    const result = await service.deliverablesFor(
      context,
      clientPrincipal(READABLE_PROJECT),
      READABLE_PROJECT,
    );
    expect(result).toEqual([]);
  });
});

describe('PortalService.filesForDeliverable (x114)', () => {
  it('returns client-safe file metadata scoped to the caller client organization', async () => {
    let seen: { deliverableId: string; clientOrganizationId: string | null } | undefined;
    const service = new PortalService(
      fakeDatabase(),
      {} as unknown as ProjectsRepository,
      {} as unknown as WorkItemsRepository,
      fakeProjections([projectionRow(DELIVERABLE, READABLE_PROJECT)]),
      fakeFiles(
        [
          { asset: fileAsset('file-1'), version: fileVersion('file-1') },
          // FIX6 item 1: checked by TManage, not virus-scanned (live has no scanner): listed.
          {
            asset: fileAsset('file-2', { status: 'scanning' }),
            version: fileVersion('file-2', { scanVerdict: 'unscanned', trustZone: 'quarantine' }),
          },
          // Blocked by the checks: never listed.
          {
            asset: fileAsset('file-3', { status: 'rejected' }),
            version: fileVersion('file-3', { scanVerdict: null }),
          },
        ],
        (input) => (seen = input),
      ),
      undefined,
      undefined,
      {
        countOpenClientVisible: () => Promise.resolve(new Map([['file-1', 3]])),
      } as unknown as ReviewThreadsRepository,
      new ClientFileSharing({ kind: 'none' }, {
        findByKey: () => Promise.resolve(undefined),
      } as unknown as OrgSettingsRepository),
    );

    const result = await service.filesForDeliverable(
      context,
      clientPrincipal(READABLE_PROJECT),
      DELIVERABLE,
    );

    // The query was scoped to this client's own organization — never a sibling client's.
    expect(seen).toEqual({ deliverableId: DELIVERABLE, clientOrganizationId: CLIENT_ORG });
    expect(result).toEqual([
      {
        id: 'file-1',
        name: 'file-1.pdf',
        sizeBytes: 2048,
        mimeType: 'application/pdf',
        updatedAt: '2026-09-15T00:00:00.000Z',
        reviewable: true,
        openComments: 3,
        safety: 'virus_scanned',
      },
      {
        id: 'file-2',
        name: 'file-2.pdf',
        sizeBytes: 2048,
        mimeType: 'application/pdf',
        updatedAt: '2026-09-15T00:00:00.000Z',
        reviewable: true,
        openComments: 0,
        safety: 'checked',
      },
    ]);
    // Never the internal object key, nor any other forbidden field.
    expect(findForbiddenClientFields(result)).toEqual([]);
  });

  it('404s on an unknown deliverable id before any file is read (Known trap)', async () => {
    let filesQueried = false;
    const service = new PortalService(
      fakeDatabase(),
      {} as unknown as ProjectsRepository,
      {} as unknown as WorkItemsRepository,
      fakeProjections([]),
      fakeFiles([], () => (filesQueried = true)),
    );

    await expect(
      service.filesForDeliverable(
        context,
        clientPrincipal(READABLE_PROJECT),
        'no-such-deliverable',
      ),
    ).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);
    expect(filesQueried).toBe(false);
  });

  it('404s when the deliverable lives in a project the client cannot read', async () => {
    let filesQueried = false;
    const service = new PortalService(
      fakeDatabase(),
      {} as unknown as ProjectsRepository,
      {} as unknown as WorkItemsRepository,
      // The deliverable is real and published, but in OTHER_PROJECT — one this client is not on.
      fakeProjections([projectionRow(DELIVERABLE, OTHER_PROJECT)]),
      fakeFiles([], () => (filesQueried = true)),
    );

    await expect(
      service.filesForDeliverable(context, clientPrincipal(READABLE_PROJECT), DELIVERABLE),
    ).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);
    expect(filesQueried).toBe(false);
  });

  it('the team preview (an internal principal) lists only the published versions’ files', async () => {
    // Live P0 (deploy 38bab83c): "Preview as client" was answered 404 here and showed no file.
    let seen: { deliverableId: string; clientOrganizationId: string | null } | undefined;
    const internal: Principal = {
      userId: 'staff-1',
      organizationId: ORG,
      kind: 'internal',
      role: 'owner',
      membershipId: 'm-1',
      membershipStatus: 'active',
      clientOrganizationId: null,
      projectIds: [],
      hasOrgWideScope: true,
    };
    const service = new PortalService(
      fakeDatabase(),
      {} as unknown as ProjectsRepository,
      {} as unknown as WorkItemsRepository,
      fakeProjections([projectionRow(DELIVERABLE, READABLE_PROJECT)]),
      fakeFiles([], (input) => (seen = input)),
      undefined,
      undefined,
      {} as unknown as ReviewThreadsRepository,
      new ClientFileSharing({ kind: 'none' }, {
        findByKey: () => Promise.resolve(undefined),
      } as unknown as OrgSettingsRepository),
    );

    await expect(service.filesForDeliverable(context, internal, DELIVERABLE)).resolves.toEqual([]);
    // `null`: never a file scoped to one client organization, only the project's published files.
    expect(seen).toEqual({ deliverableId: DELIVERABLE, clientOrganizationId: null });
  });

  it('404s a client principal with no client organization, reading nothing', async () => {
    let filesQueried = false;
    const service = new PortalService(
      fakeDatabase(),
      {} as unknown as ProjectsRepository,
      {} as unknown as WorkItemsRepository,
      fakeProjections([projectionRow(DELIVERABLE, READABLE_PROJECT)]),
      fakeFiles([], () => (filesQueried = true)),
    );
    const orphan: Principal = { ...clientPrincipal(READABLE_PROJECT), clientOrganizationId: null };

    await expect(service.filesForDeliverable(context, orphan, DELIVERABLE)).rejects.toMatchObject({
      status: 404,
    } satisfies Partial<ApiError>);
    expect(filesQueried).toBe(false);
  });
});

/**
 * CLIENT-003 — project updates, internal write and client read, over fakes with **real**
 * `authorize()`.
 *
 * The fakes stand in only for the database and the two repositories. `authorize()` is the real
 * policy, so these cases prove the actual security decisions: an internal manager may post, a
 * client may read only their own project's *published* updates, a cross-tenant or cross-client
 * `projectId` is a 404 with no write, and the view leaks no staff identity. The round-trip
 * against a live server is `apps/api/test/portal-003-updates.db.test.ts`.
 */

const UPDATES_ORG = 'org-under-test';
const INTERNAL_USER = 'user-internal-1';

/** An internal manager with org-wide scope — holds `project.manage` and passes the relation. */
function internalManager(): Principal {
  return {
    userId: INTERNAL_USER,
    organizationId: UPDATES_ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: 'membership-internal-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

const updatesContext = {
  organizationId: UPDATES_ORG,
  userId: INTERNAL_USER,
} as unknown as TenantContext;

/** A fake database whose `read` and `transaction` both run the unit of work with an ignored runner. */
function fakeDatabaseWithTx(): TenantDatabase {
  const runner = {} as never;
  return {
    read: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
    transaction: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> =>
      work(runner),
  } as unknown as TenantDatabase;
}

/** A projects repo that resolves exactly the ids it was told exist (tenant-scoped `findById`). */
function fakeProjects(existing: readonly string[]): ProjectsRepository {
  return {
    findById: (_r: never, _c: TenantContext, id: string) =>
      Promise.resolve(existing.includes(id) ? ({ id } as unknown as ProjectRow) : null),
  } as unknown as ProjectsRepository;
}

/** A stateful project-updates store: `create` appends, `list` filters by project + published gate. */
function fakeUpdates(): {
  repo: ProjectUpdatesRepository;
  created: CreateProjectUpdateInput[];
  rows: ProjectUpdateRow[];
} {
  const created: CreateProjectUpdateInput[] = [];
  const rows: ProjectUpdateRow[] = [];
  let seq = 0;
  const repo = {
    create: (_r: never, _c: TenantContext, input: CreateProjectUpdateInput) => {
      created.push(input);
      seq += 1;
      const row = {
        id: `u-${seq}`,
        organizationId: UPDATES_ORG,
        projectId: input.projectId,
        title: input.title,
        body: input.body,
        published: input.published,
        createdByUserId: input.createdByUserId,
        createdAt: new Date(`2026-09-2${seq}T00:00:00.000Z`),
        updatedAt: new Date(`2026-09-2${seq}T00:00:00.000Z`),
      } as unknown as ProjectUpdateRow;
      rows.push(row);
      return Promise.resolve(row);
    },
    list: (_r: never, _c: TenantContext, options: ListProjectUpdatesOptions) =>
      Promise.resolve(
        rows.filter(
          (row) => row.projectId === options.projectId && (!options.publishedOnly || row.published),
        ),
      ),
  } as unknown as ProjectUpdatesRepository;
  return { repo, created, rows };
}

function serviceFor(
  existingProjects: readonly string[],
  updates: ReturnType<typeof fakeUpdates>,
): PortalService {
  return new PortalService(
    fakeDatabaseWithTx(),
    fakeProjects(existingProjects),
    {} as unknown as WorkItemsRepository,
    {} as unknown as ClientProjectionsRepository,
    {} as unknown as FileAssetsRepository,
    updates.repo,
  );
}

const PROJECT = 'project-visible';

describe('PortalService.postUpdate + updatesFor (CLIENT-003)', () => {
  it('posts an update as the context user and never echoes the author to a client', async () => {
    const updates = fakeUpdates();
    const service = serviceFor([PROJECT], updates);

    const view = await service.postUpdate(updatesContext, internalManager(), {
      projectId: PROJECT,
      title: 'Kickoff',
      body: 'We have started.',
      published: true,
    });

    // The author is the context user, not a body field.
    expect(updates.created[0]?.createdByUserId).toBe(INTERNAL_USER);
    // The client-facing view carries no staff identity (§4 excludes staff).
    expect(Object.keys(view).sort()).toEqual(
      ['body', 'createdAt', 'id', 'projectId', 'published', 'title'].sort(),
    );
    expect(view).not.toHaveProperty('createdByUserId');
    expect(view).not.toHaveProperty('organizationId');
  });

  it('round-trips a published update to the client and hides an unpublished one', async () => {
    const updates = fakeUpdates();
    const service = serviceFor([PROJECT], updates);
    const manager = internalManager();

    await service.postUpdate(updatesContext, manager, {
      projectId: PROJECT,
      title: 'Shipped the homepage',
      body: 'It is live.',
      published: true,
    });
    await service.postUpdate(updatesContext, manager, {
      projectId: PROJECT,
      title: 'Internal draft',
      body: 'Not ready for the client.',
      published: false,
    });

    const client = clientPrincipal(PROJECT);
    const clientCtx = {
      organizationId: UPDATES_ORG,
      userId: 'client-user',
    } as unknown as TenantContext;
    const seen = await service.updatesFor(clientCtx, client, PROJECT);

    expect(seen.map((u) => u.title)).toEqual(['Shipped the homepage']);
    expect(seen.every((u) => u.published)).toBe(true);
  });

  it('answers 404 and writes nothing for an unknown or cross-tenant projectId', async () => {
    const updates = fakeUpdates();
    const service = serviceFor([PROJECT], updates); // the named project does NOT exist

    await expect(
      service.postUpdate(updatesContext, internalManager(), {
        projectId: 'project-elsewhere',
        title: 'X',
        body: 'y',
        published: true,
      }),
    ).rejects.toMatchObject({ status: 404 });

    // The Known-trap guarantee: no write on a project that does not resolve in this tenant.
    expect(updates.created).toHaveLength(0);
  });

  it('answers 404 and writes nothing when the caller cannot manage the project', async () => {
    const updates = fakeUpdates();
    const service = serviceFor([PROJECT], updates);

    // A client principal never holds `project.manage`; the project resolves, authorize denies.
    await expect(
      service.postUpdate(updatesContext, clientPrincipal(PROJECT), {
        projectId: PROJECT,
        title: 'X',
        body: 'y',
        published: true,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(updates.created).toHaveLength(0);
  });

  it('answers 404 when a client reads a project outside their own scope', async () => {
    const updates = fakeUpdates();
    const service = serviceFor([PROJECT], updates);

    const client = clientPrincipal(PROJECT); // scoped to PROJECT only
    const clientCtx = {
      organizationId: UPDATES_ORG,
      userId: 'client-user',
    } as unknown as TenantContext;

    await expect(
      service.updatesFor(clientCtx, client, 'project-someone-elses'),
    ).rejects.toMatchObject({ status: 404 });
  });
});
