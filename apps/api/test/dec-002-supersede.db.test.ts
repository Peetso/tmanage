import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { DecisionsRepository } from '../src/modules/decisions/decisions.repository.js';
import { DecisionSupersessionsRepository } from '../src/modules/decisions/decision-supersessions.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * DEC-01-b / DEC-02 (x117). The supersede-chain edge against a real server and the adversarial
 * near-identical tenant pair the isolation corpus uses. Under test: the migration applies and a
 * tenant-scoped supersession round-trips (two decisions of one project, an edge, then the scoped
 * "superseded by" / "supersedes" reads), the superseded decision's status flips at the engine
 * (proving 0038 relaxed the immutability trigger to `status`), and an edge can never name another
 * tenant's decision — the composite foreign key refuses it. The pair's ids differ only in the final
 * hex digit, so a missing predicate would leak rather than pass.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let northstar: TenantContext;
let twin: TenantContext;
const decisions = new DecisionsRepository();
const supersessions = new DecisionSupersessionsRepository();

const contextFor = (organizationId: string, userId: string, membershipId: string): TenantContext =>
  createTenantContext({
    organizationId,
    userId,
    membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-08-16',
    correlationId: uuidv7(),
  });

const AT = new Date('2026-06-01T09:00:00.000Z');

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  northstar = contextFor(
    world.northstar.organizationId,
    world.northstar.owner.id,
    world.northstar.owner.membershipId,
  );
  twin = contextFor(world.twin.organizationId, world.twin.owner.id, world.twin.owner.membershipId);
});

afterAll(async () => {
  await db?.stop();
});

async function seedDecision(
  context: TenantContext,
  projectId: string,
  ownerId: string,
  title: string,
) {
  return tenant.transaction(context, (tx) =>
    decisions.create(tx, context, {
      projectId,
      title,
      statement: `Statement for ${title}.`,
      status: 'accepted',
      decidedBy: ownerId,
      decidedAt: AT,
    }),
  );
}

describe('a tenant-scoped supersession round-trips', () => {
  it('records the edge, flips the superseded status, and reads the chain both ways', async () => {
    const oldDecision = await seedDecision(
      northstar,
      world.northstar.projectId,
      world.northstar.owner.id,
      'The old way',
    );
    const newDecision = await seedDecision(
      northstar,
      world.northstar.projectId,
      world.northstar.owner.id,
      'The new way',
    );

    await tenant.transaction(northstar, async (tx) => {
      await supersessions.create(tx, northstar, {
        decisionId: oldDecision.id,
        supersededByDecisionId: newDecision.id,
        createdBy: world.northstar.owner.id,
      });
      // The relaxed 0038 trigger admits this status write; 0037's refused every update.
      await decisions.updateStatus(tx, northstar, oldDecision.id, 'superseded');
    });

    const flipped = await tenant.read(northstar, (tx) =>
      decisions.findById(tx, northstar, oldDecision.id),
    );
    expect(flipped?.status).toBe('superseded');

    const supersededBy = await tenant.read(northstar, (tx) =>
      supersessions.findSupersededBy(tx, northstar, oldDecision.id),
    );
    expect(supersededBy?.supersededByDecisionId).toBe(newDecision.id);

    const supersedes = await tenant.read(northstar, (tx) =>
      supersessions.listSupersedes(tx, northstar, newDecision.id),
    );
    expect(supersedes.map((edge) => edge.decisionId)).toEqual([oldDecision.id]);
  });
});

describe('an edge never crosses a tenant boundary', () => {
  it('refuses an edge naming another tenant’s decision (composite foreign key)', async () => {
    const mine = await seedDecision(
      northstar,
      world.northstar.projectId,
      world.northstar.owner.id,
      'Mine',
    );
    const theirs = await seedDecision(twin, world.twin.projectId, world.twin.owner.id, 'Theirs');

    await expect(
      tenant.transaction(northstar, (tx) =>
        supersessions.create(tx, northstar, {
          decisionId: mine.id,
          supersededByDecisionId: theirs.id,
          createdBy: world.northstar.owner.id,
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });
});
