import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { DecisionsService } from './decisions.service.js';
import type { DecisionsRepository } from './decisions.repository.js';
import type { DecisionSupersessionsRepository } from './decision-supersessions.repository.js';
import type { DecisionLocksRepository } from './decision-lock.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { MeetingsRepository } from '../calendar/meetings.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  DecisionLockRow,
  DecisionRow,
  DecisionSupersessionRow,
} from '../../common/database/schema.js';

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
/** A15. A chat message in one of PROJECT's channels. */
const SOURCE_MESSAGE = 'message-0000-0000-0000-0000-000000000001';

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
  edges: DecisionSupersessionRow[];
  lockStore: DecisionLockRow[];
} {
  const store: DecisionRow[] = [...seed];
  const edges: DecisionSupersessionRow[] = [];
  const lockStore: DecisionLockRow[] = [];
  let seq = store.length;
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    // A15. The detail page's extra reads: the decider's name and a message of this project's
    // channels (`SOURCE_MESSAGE` only, and only for PROJECT).
    findMemberName: async (_runner: unknown, _ctx: unknown, userId: string) =>
      userId === USER ? 'Omar Adel' : null,
    findSourceMessage: async (
      _runner: unknown,
      _ctx: unknown,
      projectId: string,
      messageId: string,
    ) =>
      projectId === PROJECT && messageId === SOURCE_MESSAGE
        ? {
            messageId,
            conversationId: 'conversation-0000-0000-0000-000000000001',
            channelName: 'atlas-relaunch',
            authorName: 'Salma Riad',
            body: '  Can we also see the mobile booking flow before launch?  ',
            createdAt: new Date('2026-10-15T10:51:00.000Z'),
          }
        : null,
    updateDetails: async (
      _runner: unknown,
      ctx: TenantContext,
      decisionId: string,
      input: { readonly rationale?: string | null; readonly audience?: DecisionRow['audience'] },
    ) => {
      const row = store.find(
        (candidate) =>
          candidate.id === decisionId && candidate.organizationId === ctx.organizationId,
      );
      if (!row) throw new Error(`decision ${decisionId} not found`);
      if (input.rationale !== undefined) row.rationale = input.rationale;
      if (input.audience !== undefined) row.audience = input.audience;
      return row;
    },
    list: async (_runner: unknown, _ctx: unknown, options: { readonly projectId: string }) =>
      store
        .filter((row) => row.projectId === options.projectId)
        .sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime()),
    // Tenant-scoped like the real repository: a row of another org resolves to null here.
    findById: async (_runner: unknown, ctx: TenantContext, decisionId: string) =>
      store.find((row) => row.id === decisionId && row.organizationId === ctx.organizationId) ??
      null,
    updateStatus: async (
      _runner: unknown,
      ctx: TenantContext,
      decisionId: string,
      status: DecisionRow['status'],
    ) => {
      const row = store.find(
        (candidate) =>
          candidate.id === decisionId && candidate.organizationId === ctx.organizationId,
      );
      if (!row) throw new Error(`decision ${decisionId} not found`);
      row.status = status;
      return row;
    },
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
        readonly rationale?: string | null;
        readonly sourceMessageId?: string | null;
        readonly audience?: DecisionRow['audience'];
      },
    ) => {
      const row = {
        number: store.length + 1,
        rationale: input.rationale ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
        audience: input.audience ?? 'internal',
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
  const supersessions = {
    create: async (
      _runner: unknown,
      ctx: TenantContext,
      input: {
        readonly decisionId: string;
        readonly supersededByDecisionId: string;
        readonly createdBy: string;
      },
    ) => {
      const row = {
        id: `supersession-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        decisionId: input.decisionId,
        supersededByDecisionId: input.supersededByDecisionId,
        createdBy: input.createdBy,
        createdAt: new Date(),
      } as DecisionSupersessionRow;
      edges.push(row);
      return row;
    },
    findSupersededBy: async (_runner: unknown, ctx: TenantContext, decisionId: string) =>
      edges.find(
        (edge) => edge.decisionId === decisionId && edge.organizationId === ctx.organizationId,
      ) ?? null,
    listSupersedes: async (_runner: unknown, ctx: TenantContext, supersededByDecisionId: string) =>
      edges.filter(
        (edge) =>
          edge.supersededByDecisionId === supersededByDecisionId &&
          edge.organizationId === ctx.organizationId,
      ),
  } as unknown as DecisionSupersessionsRepository;
  // SEC / Decisions (x150). No decision is locked in these cases, so the lock guard the lifecycle
  // methods now consult always finds none; the lock surface itself is proved in
  // `decision-lock.controller.test.ts`.
  const locks = {
    findByDecisionId: async (_runner: unknown, ctx: TenantContext, decisionId: string) =>
      lockStore.find(
        (lock) => lock.decisionId === decisionId && lock.organizationId === ctx.organizationId,
      ) ?? null,
    create: async (
      _runner: unknown,
      ctx: TenantContext,
      input: { readonly decisionId: string; readonly lockedBy: string },
    ) => {
      const row = {
        id: `decision-lock-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        decisionId: input.decisionId,
        lockedBy: input.lockedBy,
        lockedAt: new Date(),
      } as DecisionLockRow;
      lockStore.push(row);
      return row;
    },
  } as unknown as DecisionLocksRepository;
  return {
    service: new DecisionsService(database, repository, projects, meetings, supersessions, locks),
    store,
    edges,
    lockStore,
  };
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

describe('DecisionsService lifecycle (DEC-01-b / DEC-02)', () => {
  const PROPOSED = decisionRow('decision-proposed', PROJECT, DECIDED_AT);
  const OTHER = decisionRow('decision-other', PROJECT, DECIDED_AT);

  it('accepts a proposed decision (proposed → accepted)', async () => {
    const { service, store } = serviceWith([{ ...PROPOSED }]);
    const view = await service.accept(context, member([PROJECT]), PROPOSED.id);
    expect(view.status).toBe('accepted');
    expect(store.find((row) => row.id === PROPOSED.id)?.status).toBe('accepted');
  });

  it('refuses accepting a non-proposed decision as a 409, with no write', async () => {
    const accepted = {
      ...decisionRow('decision-accepted', PROJECT, DECIDED_AT),
      status: 'accepted' as const,
    };
    const { service, store } = serviceWith([accepted]);
    const error = await service
      .accept(context, member([PROJECT]), accepted.id)
      .catch((caught: unknown) => caught);
    expect((error as ApiError).status).toBe(409);
    expect(store.find((row) => row.id === accepted.id)?.status).toBe('accepted');
  });

  it('refuses accepting an unknown/cross-tenant decision as 404 for an org-wide caller', async () => {
    const { service } = serviceWith([{ ...PROPOSED }]);
    const error = await service
      .accept(context, member([], true), 'decision-0000-0000-0000-0000000000ff')
      .catch((caught: unknown) => caught);
    expect((error as ApiError).status).toBe(404);
  });

  it('hides a decision from a non-member on accept, as not-found', async () => {
    const { service, store } = serviceWith([{ ...PROPOSED }]);
    const error = await service
      .accept(context, member([]), PROPOSED.id)
      .catch((caught: unknown) => caught);
    expect((error as ApiError).status).toBe(404);
    expect(store.find((row) => row.id === PROPOSED.id)?.status).toBe('proposed');
  });

  it('supersedes a decision by another, writing the edge and flipping status in one call', async () => {
    const { service, store, edges } = serviceWith([{ ...PROPOSED }, { ...OTHER }]);
    const detail = await service.supersede(context, member([PROJECT]), PROPOSED.id, OTHER.id);
    expect(store.find((row) => row.id === PROPOSED.id)?.status).toBe('superseded');
    expect(edges).toHaveLength(1);
    expect(detail.supersededBy?.decisionId).toBe(OTHER.id);
    // Read the superseder's detail: it lists what it supersedes.
    const superseder = await service.detail(context, member([PROJECT]), OTHER.id);
    expect(superseder.supersedes.map((edge) => edge.decisionId)).toEqual([PROPOSED.id]);
  });

  it('refuses a decision superseding itself as 422, with no write', async () => {
    const { service, store, edges } = serviceWith([{ ...PROPOSED }]);
    const error = await service
      .supersede(context, member([PROJECT]), PROPOSED.id, PROPOSED.id)
      .catch((caught: unknown) => caught);
    expect((error as ApiError).status).toBe(422);
    expect(edges).toHaveLength(0);
    expect(store.find((row) => row.id === PROPOSED.id)?.status).toBe('proposed');
  });

  it('refuses superseding by a decision of another project as 404, with no write', async () => {
    const foreign = decisionRow('decision-otherproject', OTHER_PROJECT, DECIDED_AT);
    const { service, store, edges } = serviceWith(
      [{ ...PROPOSED }, foreign],
      [PROJECT, OTHER_PROJECT],
    );
    const error = await service
      .supersede(context, member([], true), PROPOSED.id, foreign.id)
      .catch((caught: unknown) => caught);
    expect((error as ApiError).status).toBe(404);
    expect(edges).toHaveLength(0);
    expect(store.find((row) => row.id === PROPOSED.id)?.status).toBe('proposed');
  });

  it('refuses superseding by an unknown/cross-tenant decision as 404 (Known-trap)', async () => {
    const { service, edges } = serviceWith([{ ...PROPOSED }]);
    const error = await service
      .supersede(context, member([], true), PROPOSED.id, 'decision-0000-0000-0000-0000000000ff')
      .catch((caught: unknown) => caught);
    expect((error as ApiError).status).toBe(404);
    expect(edges).toHaveLength(0);
  });

  it('refuses superseding an already-superseded decision as 409', async () => {
    const superseded = {
      ...decisionRow('decision-super', PROJECT, DECIDED_AT),
      status: 'superseded' as const,
    };
    const { service, edges } = serviceWith([superseded, { ...OTHER }]);
    const error = await service
      .supersede(context, member([PROJECT]), superseded.id, OTHER.id)
      .catch((caught: unknown) => caught);
    expect((error as ApiError).status).toBe(409);
    expect(edges).toHaveLength(0);
  });

  it('A15: the detail carries the number, rationale, audience, decider name and source card', async () => {
    const { service } = serviceWith();
    const created = await service.create(context, member([PROJECT]), {
      projectId: PROJECT,
      title: 'Launch the mobile booking flow first',
      statement: 'Desktop follows two weeks later.',
      status: 'accepted',
      decidedAt: DECIDED_AT,
      rationale: 'Most bookings come from phones.',
      sourceMessageId: SOURCE_MESSAGE,
      audience: 'client_visible',
    });
    const detail = await service.detail(context, member([PROJECT]), created.id);
    expect(detail.number).toBe(1);
    expect(detail.rationale).toBe('Most bookings come from phones.');
    expect(detail.audience).toBe('client_visible');
    expect(detail.decidedByName).toBe('Omar Adel');
    expect(detail.source).toEqual({
      messageId: SOURCE_MESSAGE,
      conversationId: 'conversation-0000-0000-0000-000000000001',
      channelName: 'atlas-relaunch',
      authorName: 'Salma Riad',
      quote: 'Can we also see the mobile booking flow before launch?',
      at: '2026-10-15T10:51:00.000Z',
    });
  });

  it('A15: a source message outside the decision’s project is a 404 with no write', async () => {
    const { service, store } = serviceWith();
    const error = await service
      .create(context, member([PROJECT]), {
        projectId: PROJECT,
        title: 'T',
        statement: 'S',
        status: 'proposed',
        decidedAt: DECIDED_AT,
        sourceMessageId: 'message-of-another-project',
      })
      .catch((caught: unknown) => caught);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });

  it('A15: Edit changes the rationale and audience; a locked decision refuses it', async () => {
    const { service, lockStore } = serviceWith([{ ...PROPOSED }]);
    const edited = await service.updateDetails(context, member([PROJECT]), PROPOSED.id, {
      rationale: 'Because phones.',
      audience: 'client_visible',
    });
    expect(edited.rationale).toBe('Because phones.');
    expect(edited.audience).toBe('client_visible');

    lockStore.push({
      id: 'lock-1',
      organizationId: ORG,
      decisionId: PROPOSED.id,
      lockedBy: USER,
      lockedAt: new Date(),
    } as DecisionLockRow);
    const error = await service
      .updateDetails(context, member([PROJECT]), PROPOSED.id, { rationale: 'Again' })
      .catch((caught: unknown) => caught);
    expect((error as ApiError).status).toBe(409);
  });

  it('hides a decision’s detail from a non-member, as not-found', async () => {
    const { service } = serviceWith([{ ...PROPOSED }]);
    const error = await service
      .detail(context, member([]), PROPOSED.id)
      .catch((caught: unknown) => caught);
    expect((error as ApiError).status).toBe(404);
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
