import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { MeetingsService } from './meetings.service.js';
import type { MeetingsRepository } from './meetings.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MeetingRow } from '../../common/database/schema.js';

/**
 * CAL-01 / MTG-01 (x90) service proofs, database-free over the module's fakes. The migration and
 * the tenant-scoped SQL round-trip are proven separately in `apps/api/test/migrator.db.test.ts`
 * and `apps/api/test/cal-001-meetings.db.test.ts`; here the subject is the service's own logic —
 * create-then-read, empty, and the relation filter that drops a cross-tenant or non-member row.
 *
 * The fake `list` deliberately does **not** apply the tenant scope the real SQL applies, so a
 * cross-tenant row reaches the service and its `authorize()` filter must drop it — belt-and-braces
 * to the scoped query, exactly as the work-items roll-up test does.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
/** A project id that resolves to no row inside the tenant (unknown or another tenant's). */
const UNKNOWN_PROJECT = 'project-0000-0000-0000-0000-0000000000ff';
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

/**
 * A service over an in-memory store whose `list` omits the tenant scope on purpose.
 *
 * `knownProjectIds` is the set of project ids the fake `ProjectsRepository.findById` resolves
 * inside the tenant; anything else returns `null`, standing in for an unknown or cross-tenant
 * project. `create` resolves the named project first, so a project must be known for a create to
 * reach the write.
 */
function serviceWith(
  seed: readonly MeetingRow[] = [],
  knownProjectIds: readonly string[] = [PROJECT],
): {
  service: MeetingsService;
  store: MeetingRow[];
} {
  const store: MeetingRow[] = [...seed];
  let seq = store.length;
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    list: async (
      _runner: unknown,
      _ctx: unknown,
      options: { readonly projectId: string; readonly after?: string },
    ) =>
      store.filter(
        (row) =>
          row.projectId === options.projectId &&
          (options.after === undefined || row.id > options.after),
      ),
    create: async (
      _runner: unknown,
      ctx: TenantContext,
      input: {
        readonly projectId: string;
        readonly title: string;
        readonly startsAt: Date;
        readonly agendaNote?: string | null;
        readonly createdByUserId: string;
      },
    ) => {
      const row = {
        id: `meeting-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        projectId: input.projectId,
        title: input.title,
        startsAt: input.startsAt,
        agendaNote: input.agendaNote ?? null,
        createdByUserId: input.createdByUserId,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as MeetingRow;
      store.push(row);
      return row;
    },
  } as unknown as MeetingsRepository;
  const projects = {
    findById: async (_runner: unknown, _ctx: unknown, projectId: string) =>
      knownProjectIds.includes(projectId) ? ({ id: projectId } as unknown) : null,
  } as unknown as ProjectsRepository;
  return { service: new MeetingsService(database, repository, projects), store };
}

const STARTS_AT = new Date('2026-10-01T14:00:00.000Z');

describe('MeetingsService', () => {
  it('creates a meeting, then reads it back for a project member', async () => {
    const { service } = serviceWith();
    const created = await service.create(context, member([PROJECT]), {
      projectId: PROJECT,
      title: 'Kickoff',
      startsAt: STARTS_AT,
      agendaNote: 'agenda',
    });

    expect(created.projectId).toBe(PROJECT);
    expect(created.title).toBe('Kickoff');
    expect(created.startsAt).toBe(STARTS_AT.toISOString());
    expect(created.createdByUserId).toBe(USER);
    // The wire projection never echoes the tenant id.
    expect(JSON.stringify(created)).not.toContain(ORG);

    const listed = await service.list(context, member([PROJECT]), { projectId: PROJECT });
    expect(listed.map((m) => m.id)).toEqual([created.id]);
    expect(listed[0]?.agendaNote).toBe('agenda');
  });

  it('reads an empty project as empty', async () => {
    const { service } = serviceWith();
    const listed = await service.list(context, member([PROJECT]), { projectId: PROJECT });
    expect(listed).toEqual([]);
  });

  it('never lets a cross-tenant meeting contribute to the list', async () => {
    const foreign = {
      id: 'meeting-foreign-000000000000000001',
      organizationId: OTHER_ORG,
      projectId: PROJECT,
      title: 'Someone else’s meeting',
      startsAt: STARTS_AT,
      agendaNote: null,
      createdByUserId: 'user-other-00000000000000000002',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as MeetingRow;
    const { service } = serviceWith([foreign]);

    const listed = await service.list(context, member([PROJECT]), { projectId: PROJECT });
    expect(listed).toEqual([]);
    expect(JSON.stringify(listed)).not.toContain(OTHER_ORG);
  });

  it('hides a project’s meetings from a non-member (relation filter)', async () => {
    const mine = {
      id: 'meeting-0000-0000-0000-000000000010',
      organizationId: ORG,
      projectId: PROJECT,
      title: 'Members only',
      startsAt: STARTS_AT,
      agendaNote: null,
      createdByUserId: USER,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as MeetingRow;
    const { service } = serviceWith([mine]);

    // A member of no project sees nothing; an org-wide role sees it.
    expect(await service.list(context, member([]), { projectId: PROJECT })).toEqual([]);
    const asOwner = await service.list(context, member([], true), { projectId: PROJECT });
    expect(asOwner.map((m) => m.id)).toEqual([mine.id]);
  });

  it('refuses a create into a project the caller is not a member of, as not-found', async () => {
    const { service, store } = serviceWith();
    const error = await service
      .create(context, member([]), { projectId: PROJECT, title: 'Sneaky', startsAt: STARTS_AT })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    // Nothing was written.
    expect(store).toHaveLength(0);
  });

  it('refuses a create naming an unknown or cross-tenant project as not-found for an organization-wide caller, and writes nothing', async () => {
    // An org-wide role (owner) passes the relation gate, so before the fix an unknown projectId
    // fell through to the composite foreign key and surfaced as a 500. The tenant-scoped project
    // resolution now maps the lookup miss to 404 with no write, matching ConversationsService.
    const { service, store } = serviceWith();
    const error = await service
      .create(context, member([], true), {
        projectId: UNKNOWN_PROJECT,
        title: 'No such project',
        startsAt: STARTS_AT,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });
});
