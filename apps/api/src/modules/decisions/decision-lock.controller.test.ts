import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { DecisionLockController } from './decision-lock.controller.js';
import { DecisionsService } from './decisions.service.js';
import type { DecisionsRepository } from './decisions.repository.js';
import type { DecisionSupersessionsRepository } from './decision-supersessions.repository.js';
import type {
  CreateDecisionLockInput,
  DecisionLocksRepository,
} from './decision-lock.repository.js';
import { DuplicateDecisionLockError } from './decision-lock.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { MeetingsRepository } from '../calendar/meetings.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { DecisionLockRow, DecisionRow } from '../../common/database/schema.js';

/**
 * SEC / Decisions (x150) — the decision-lock write boundary, over fakes with **real** `authorize()`.
 *
 * The fakes stand in only for the database and the repositories; `authorize()` is the real policy, so
 * these cases prove the actual security decisions: a member of the decision's project may lock it, a
 * lock then refuses every lifecycle write to that decision (409, no write), a re-lock is a 409 with no
 * second row, and an unknown/cross-tenant `decisionId` is a 404 with no write. The route ceiling that
 * turns a role without `meeting.write` into a 403 is asserted from the controller's own
 * `@RequireCapability` metadata — `CapabilityGuard` reads exactly that. No DB in this suite (the chain
 * owns the SQL round-trip and the migrator proof).
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';
const DECIDED_AT = new Date('2026-10-01T14:00:00.000Z');
/** A decision id that resolves to no row inside the tenant (unknown or another tenant's). */
const UNKNOWN_DECISION = 'decision-0000-0000-0000-0000-0000000000ff';

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

function decisionRow(id: string, status: DecisionRow['status'] = 'proposed'): DecisionRow {
  return {
    id,
    organizationId: ORG,
    projectId: PROJECT,
    meetingId: null,
    title: `Decision ${id}`,
    statement: 'A decision.',
    status,
    decidedBy: USER,
    decidedAt: DECIDED_AT,
    createdAt: new Date(),
  } as DecisionRow;
}

/**
 * A service over in-memory stores. `decisions.findById` is tenant-scoped like the real repository (a
 * row of another org resolves to null); `locks` enforces the one-per-decision unique key so a re-lock
 * throws {@link DuplicateDecisionLockError} the way the engine would.
 */
function serviceWith(seed: readonly DecisionRow[] = []): {
  service: DecisionsService;
  store: DecisionRow[];
  lockStore: DecisionLockRow[];
} {
  const store: DecisionRow[] = [...seed];
  const lockStore: DecisionLockRow[] = [];
  let seq = 0;
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    findById: async (_r: unknown, ctx: TenantContext, decisionId: string) =>
      store.find((row) => row.id === decisionId && row.organizationId === ctx.organizationId) ??
      null,
    updateStatus: async (
      _r: unknown,
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
  } as unknown as DecisionsRepository;
  const projects = { findById: async () => null } as unknown as ProjectsRepository;
  const meetings = { findById: async () => null } as unknown as MeetingsRepository;
  const supersessions = {
    create: async () => {
      throw new Error('not used in these cases');
    },
    findSupersededBy: async () => null,
    listSupersedes: async () => [],
  } as unknown as DecisionSupersessionsRepository;
  const locks = {
    findByDecisionId: async (_r: unknown, ctx: TenantContext, decisionId: string) =>
      lockStore.find(
        (lock) => lock.decisionId === decisionId && lock.organizationId === ctx.organizationId,
      ) ?? null,
    create: async (_r: unknown, ctx: TenantContext, input: CreateDecisionLockInput) => {
      if (lockStore.some((lock) => lock.decisionId === input.decisionId)) {
        throw new DuplicateDecisionLockError(input.decisionId);
      }
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
    lockStore,
  };
}

describe('DecisionsService.lock (x150)', () => {
  it('locks a decision for a project member and records who and when', async () => {
    const decision = decisionRow('decision-1');
    const { service, lockStore } = serviceWith([decision]);

    const view = await service.lock(context, member([PROJECT]), decision.id);

    expect(view.decisionId).toBe(decision.id);
    expect(view.lockedBy).toBe(USER);
    expect(typeof view.lockedAt).toBe('string');
    // The wire projection never echoes the tenant id.
    expect(JSON.stringify(view)).not.toContain(ORG);
    expect(lockStore).toHaveLength(1);
  });

  it('refuses every lifecycle write to a locked decision as 409, with no write', async () => {
    const decision = decisionRow('decision-1', 'proposed');
    const { service, store } = serviceWith([decision]);
    await service.lock(context, member([PROJECT]), decision.id);

    const error = await service
      .accept(context, member([PROJECT]), decision.id)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    // No write: the decision stays proposed.
    expect(store.find((row) => row.id === decision.id)?.status).toBe('proposed');
  });

  it('answers 409 on a re-lock and writes no second lock row', async () => {
    const decision = decisionRow('decision-1');
    const { service, lockStore } = serviceWith([decision]);
    await service.lock(context, member([PROJECT]), decision.id);

    const error = await service
      .lock(context, member([PROJECT]), decision.id)
      .catch((caught: unknown) => caught);
    expect((error as ApiError).status).toBe(409);
    // No second row: the lock (the durable record of the seal) is written exactly once.
    expect(lockStore).toHaveLength(1);
  });

  it('answers 404 and writes nothing for an unknown or cross-tenant decisionId', async () => {
    const foreign = {
      ...decisionRow('decision-foreign'),
      organizationId: OTHER_ORG,
    } as DecisionRow;
    const { service, lockStore } = serviceWith([foreign]);

    // An org-wide caller still gets not-found: the id does not resolve inside this tenant.
    const unknownError = await service
      .lock(context, member([], true), UNKNOWN_DECISION)
      .catch((caught: unknown) => caught);
    expect((unknownError as ApiError).status).toBe(404);

    const crossTenantError = await service
      .lock(context, member([], true), foreign.id)
      .catch((caught: unknown) => caught);
    expect((crossTenantError as ApiError).status).toBe(404);

    expect(lockStore).toHaveLength(0);
  });

  it('hides a decision from a non-member on lock, as not-found', async () => {
    const decision = decisionRow('decision-1');
    const { service, lockStore } = serviceWith([decision]);
    const error = await service
      .lock(context, member([]), decision.id)
      .catch((caught: unknown) => caught);
    expect((error as ApiError).status).toBe(404);
    expect(lockStore).toHaveLength(0);
  });
});

/**
 * The route ceiling that produces the 403 for a role without `meeting.write`.
 *
 * `CapabilityGuard` refuses the lock route before the handler runs when the role's ceiling does not
 * include the capability — the guard reads exactly the `@RequireCapability` metadata asserted here.
 * The live 403/guard round-trip is the chain's e2e; this pins the wiring the guard depends on.
 */
describe('decision-lock route capability', () => {
  const capabilityOf = (proto: object, key: string): unknown =>
    Reflect.getMetadata(REQUIRED_CAPABILITY, (proto as Record<string, unknown>)[key] as object);

  it('guards the lock route with meeting.write', () => {
    expect(capabilityOf(DecisionLockController.prototype, 'lock')).toBe('meeting.write');
  });
});
