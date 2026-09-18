import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { PortalService, progressOf } from './portal.service.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { WorkItemsRepository } from '../work/work-items.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectRow, WorkItemRow } from '../../common/database/schema.js';

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
