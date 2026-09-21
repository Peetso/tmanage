import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { DecisionsService } from './decisions.service.js';
import type { DecisionsRepository } from './decisions.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { MeetingsRepository } from '../calendar/meetings.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { DecisionRow } from '../../common/database/schema.js';

/**
 * DEC-01 (x113) service proofs, database-free over the module's fakes. The migration and the
 * tenant-scoped SQL round-trip are proven separately in `apps/api/test/migrator.db.test.ts` and
 * `apps/api/test/dec-001-decisions.db.test.ts`; here the subject is the service's own logic —
 * create-then-read, the relation filter that drops a cross-tenant or non-member row, and the
 * Known-trap: an unknown/cross-tenant project or meeting id is a 404 with no write, never a 500.
 *
 * The fake `list` deliberately does **not** apply the tenant scope the real SQL applies, so a
 * cross-tenant row reaches the service and its `authorize()` filter must drop it — belt-and-braces
 * to the scoped query, exactly as the meetings service test does.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const OTHER_PROJECT = 'project-0000-0000-0000-0000-000000000002';
/** A project id that resolves to no row inside the tenant (unknown or another tenant's). */
const UNKNOWN_PROJECT = 'project-0000-0000-0000-0000-0000000000ff';
const MEETING = 'meeting-0000-0000-0000-0000-000000000001';
const UNKNOWN_MEETING = 'meeting-0000-0000-0000-0000-0000000000ff';
const USER = 'user-0000-0000-0000-0000-000000000001';

function member(projectIds: readonly string[], hasOrgWideScope = false): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role: hasOrgWideScope ? 'owner' : 'member',
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope,
  };
}

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

const DECIDED_AT = new Date('2026-10-01T14:00:00.000Z');

/**
 * A service over an in-memory store whose `list` omits the tenant scope on purpose.
 *
 * `knownProjectIds` is the set of project ids the fake `ProjectsRepository.findById` resolves inside
 * the tenant; anything else returns `null`. `knownMeetings` maps a resolvable meeting id to the
 * project it belongs to, standing in for the tenant-scoped meeting lookup.
 */
function serviceWith(
  seed: readonly DecisionRow[] = [],
  knownProjectIds: readonly string[] = [PROJECT],
  knownMeetings: Readonly<Record<string, string>> = { [MEETING]: PROJECT },
): {
  service: DecisionsService;
  store: DecisionRow[];
} {
  const store: DecisionRow[] = [...seed];
  let seq = store.length;
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    list: async (_runner: unknown, _ctx: unknown, options: { readonly projectId: string }) =>
      store
        .filter((row) => row.projectId === options.projectId)
        .sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime()),
    create: async (
      _runner: unknown,
      ctx: TenantContext,
      input: {
        readonly projectId: string;
        readonly meetingId?: string | null;
        readonly title: string;
        readonly statement: string;
        readonly status: DecisionRow['status'];
        readonly decidedBy: string;
        readonly decidedAt: Date;
      },
    ) => {
      const row = {
        id: `decision-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        projectId: input.projectId,
        meetingId: input.meetingId ?? null,
        title: input.title,
        statement: input.statement,
        status: input.status,
        decidedBy: input.decidedBy,
        decidedAt: input.decidedAt,
        createdAt: new Date(),
      } as DecisionRow;
      store.push(row);
      return row;
    },
  } as unknown as DecisionsRepository;
  const projects = {
    findById: async (_runner: unknown, _ctx: unknown, projectId: string) =>
      knownProjectIds.includes(projectId) ? ({ id: projectId } as unknown) : null,
  } as unknown as ProjectsRepository;
  const meetings = {
    findById: async (_runner: unknown, _ctx: unknown, meetingId: string) =>
      meetingId in knownMeetings
        ? ({ id: meetingId, projectId: knownMeetings[meetingId] } as unknown)
        : null,
  } as unknown as MeetingsRepository;
  return { service: new DecisionsService(database, repository, projects, meetings), store };
}

describe('DecisionsService', () => {
  it('authors a decision, then reads it back for a project member', async () => {
    const { service } = serviceWith();
    const created = await service.create(context, member([PROJECT]), {
      projectId: PROJECT,
      title: 'Adopt the new deploy path',
      statement: 'We will deploy through the proxied app per 50-BOOTSTRAP §3.',
      status: 'accepted',
      decidedAt: DECIDED_AT,
    });

    expect(created.projectId).toBe(PROJECT);
    expect(created.title).toBe('Adopt the new deploy path');
    expect(created.status).toBe('accepted');
    expect(created.decidedBy).toBe(USER);
    expect(created.decidedAt).toBe(DECIDED_AT.toISOString());
    expect(created.meetingId).toBeNull();
    // The wire projection never echoes the tenant id.
    expect(JSON.stringify(created)).not.toContain(ORG);

    const listed = await service.list(context, member([PROJECT]), { projectId: PROJECT });
    expect(listed.map((d) => d.id)).toEqual([created.id]);
  });

  it('links a meeting of the same project when one is named', async () => {
    const { service } = serviceWith();
    const created = await service.create(context, member([PROJECT]), {
      projectId: PROJECT,
      meetingId: MEETING,
      title: 'Ship v1',
      statement: 'Agreed in the kickoff.',
      status: 'proposed',
      decidedAt: DECIDED_AT,
    });
    expect(created.meetingId).toBe(MEETING);
  });

  it('reads an empty project as empty', async () => {
    const { service } = serviceWith();
    const listed = await service.list(context, member([PROJECT]), { projectId: PROJECT });
    expect(listed).toEqual([]);
  });

  it('lists most recently decided first', async () => {
    const older = decisionRow('decision-a', PROJECT, new Date('2026-01-01T00:00:00.000Z'));
    const newer = decisionRow('decision-b', PROJECT, new Date('2026-06-01T00:00:00.000Z'));
    const { service } = serviceWith([older, newer]);
    const listed = await service.list(context, member([PROJECT]), { projectId: PROJECT });
    expect(listed.map((d) => d.id)).toEqual(['decision-b', 'decision-a']);
  });

  it('never lets a cross-tenant decision contribute to the list', async () => {
    const foreign = {
      ...decisionRow('decision-foreign', PROJECT, DECIDED_AT),
      organizationId: OTHER_ORG,
    } as DecisionRow;
    const { service } = serviceWith([foreign]);

    const listed = await service.list(context, member([PROJECT]), { projectId: PROJECT });
    expect(listed).toEqual([]);
    expect(JSON.stringify(listed)).not.toContain(OTHER_ORG);
  });

  it('hides a project’s decisions from a non-member (relation filter)', async () => {
    const mine = decisionRow('decision-mine', PROJECT, DECIDED_AT);
    const { service } = serviceWith([mine]);

    expect(await service.list(context, member([]), { projectId: PROJECT })).toEqual([]);
    const asOwner = await service.list(context, member([], true), { projectId: PROJECT });
    expect(asOwner.map((d) => d.id)).toEqual([mine.id]);
  });

  it('refuses a create into a project the caller is not a member of, as not-found', async () => {
    const { service, store } = serviceWith();
    const error = await service
      .create(context, member([]), {
        projectId: PROJECT,
        title: 'Sneaky',
        statement: 'nope',
        status: 'proposed',
        decidedAt: DECIDED_AT,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });

  it('refuses a create naming an unknown or cross-tenant project as not-found for an organization-wide caller, and writes nothing (Known-trap)', async () => {
    const { service, store } = serviceWith();
    const error = await service
      .create(context, member([], true), {
        projectId: UNKNOWN_PROJECT,
        title: 'No such project',
        statement: 'x',
        status: 'proposed',
        decidedAt: DECIDED_AT,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });

  it('refuses a create naming an unknown or cross-tenant meeting as not-found, and writes nothing (Known-trap)', async () => {
    const { service, store } = serviceWith();
    const error = await service
      .create(context, member([], true), {
        projectId: PROJECT,
        meetingId: UNKNOWN_MEETING,
        title: 'Links a ghost meeting',
        statement: 'x',
        status: 'proposed',
        decidedAt: DECIDED_AT,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });

  it('refuses a meeting that belongs to a different project of the same tenant, and writes nothing', async () => {
    // The meeting resolves inside the tenant but on OTHER_PROJECT; a decision links a meeting of
    // its own project, so this is a 404 with no write.
    const { service, store } = serviceWith([], [PROJECT, OTHER_PROJECT], {
      [MEETING]: OTHER_PROJECT,
    });
    const error = await service
      .create(context, member([], true), {
        projectId: PROJECT,
        meetingId: MEETING,
        title: 'Wrong project meeting',
        statement: 'x',
        status: 'proposed',
        decidedAt: DECIDED_AT,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });
});

function decisionRow(id: string, projectId: string, decidedAt: Date): DecisionRow {
  return {
    id,
    organizationId: ORG,
    projectId,
    meetingId: null,
    title: `Decision ${id}`,
    statement: 'A decision.',
    status: 'proposed',
    decidedBy: USER,
    decidedAt,
    createdAt: new Date(),
  } as DecisionRow;
}
