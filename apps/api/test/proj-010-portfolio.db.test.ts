import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { ApiError } from '../src/common/http/errors.js';
import { ProjectMilestonesRepository } from '../src/modules/clients/project-milestones.repository.js';
import { ProjectObjectivesRepository } from '../src/modules/projects/project-objectives.repository.js';
import { KeyResultsRepository } from '../src/modules/projects/key-results.repository.js';
import { KeyResultsService } from '../src/modules/projects/key-results.service.js';
import { ProjectRiskRegisterRepository } from '../src/modules/projects/risk-register.repository.js';
import { ProjectDependenciesService } from '../src/modules/projects/dependencies.service.js';
import { ProjectCustomFieldsRepository } from '../src/modules/projects/custom-fields.repository.js';
import { ProjectCustomFieldsService } from '../src/modules/projects/custom-fields.service.js';
import { ProjectRetroNotesRepository } from '../src/modules/projects/retro-notes.repository.js';
import { ProjectRetroNotesService } from '../src/modules/projects/retro-notes.service.js';
import { MilestoneLinksService } from '../src/modules/projects/milestone-links.service.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * PROJ / module 8 — the Projects additions built since the isolation proof: milestones (0048) and
 * their dependency links, the internal risk register (0088), objective key results (0087),
 * cross-project dependencies (0177), project custom fields (0178) and retrospective notes (0179).
 * `proj-001-*.db.test.ts` and `projects-repository.db.test.ts` cover project creation and
 * objectives; this suite owns everything downstream of them, and nothing they already assert.
 *
 * The pair the corpus runs on is `seed-two-tenants`' adversarial twin: a near-identical name and an
 * id one hex digit away from Northstar's, with an identically titled project. A statement that loses
 * its `organization_id` predicate returns the twin's rows beside Northstar's rather than failing
 * loudly, so every isolation case here is checked against that twin, not an obviously different
 * tenant.
 *
 * What only this suite can prove, against a real MySQL:
 *
 * 1. **Every child table scopes to its project's org.** A row created in the twin is 0 rows / null
 *    through a Northstar context — the composite `(organization_id, …)` keys and the repository
 *    predicates together, not the application layer alone.
 * 2. **A child can never name a parent in another org.** The composite foreign keys refuse a
 *    milestone / risk / key-result / dependency / retro-note whose `organization_id` and parent id
 *    do not exist as a *pair*, even when both ids exist individually; where there is no FK (a custom
 *    field value's project), the service resolves it tenant-scoped and returns 404.
 * 3. **The dependency invariants hold.** A milestone dependency refuses a self-link and any cycle
 *    (direct and transitive); a project dependency refuses a self-edge (400) and a duplicate (409).
 *    Project-level edges are deliberately *not* acyclic (0177 guards only self/duplicate) — the
 *    reverse edge is characterised here so the contrast with milestone links is on the record.
 * 4. **A key result ties to an objective in the same org**, and progress is computed, not stored.
 * 5. **A custom-field value matches its field's type** — a `number` must parse, a `select` must be
 *    one of the declared options.
 * 6. **A retro note is append-and-delete only**, scoped on delete so a cross-tenant id removes
 *    nothing, and a milestone it references must belong to the same project.
 * 7. **Identity is immutable at the engine.** The `BEFORE UPDATE` triggers refuse an admin session's
 *    attempt to re-point a row's project / objective — ADR-0001 layers 3-4 are application-side and a
 *    direct SQL session bypasses both.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;

let northstar: TenantContext;
let twin: TenantContext;
let northstarPrincipal: Principal;

const milestones = new ProjectMilestonesRepository();
const objectives = new ProjectObjectivesRepository();
const keyResults = new KeyResultsRepository();
const risks = new ProjectRiskRegisterRepository();
const customFields = new ProjectCustomFieldsRepository();
const retroNotes = new ProjectRetroNotesRepository();

let keyResultsService: KeyResultsService;
let dependenciesService: ProjectDependenciesService;
let customFieldsService: ProjectCustomFieldsService;
let retroNotesService: ProjectRetroNotesService;
let milestoneLinksService: MilestoneLinksService;

const FK_FAILS = /foreign key constraint fails/i;
const IMMUTABLE = /immutable/i;

const contextFor = (organizationId: string, userId: string, membershipId: string): TenantContext =>
  createTenantContext({
    organizationId,
    userId,
    membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-08-30',
    correlationId: uuidv7(),
  });

const ownerPrincipal = (
  organizationId: string,
  userId: string,
  membershipId: string,
): Principal => ({
  userId,
  organizationId,
  kind: 'internal',
  role: 'owner',
  membershipId,
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
});

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

async function expectApiError(promise: Promise<unknown>, status: number): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(status);
    return error as ApiError;
  }
  throw new Error(`expected a ${status} refusal and got success`);
}

/** A milestone on a Northstar project, created through the real repository under the acting tenant. */
async function newMilestone(projectId: string, title: string): Promise<string> {
  const row = await tenant.transaction(northstar, (tx) =>
    milestones.create(tx, northstar, {
      projectId,
      title,
      dueOn: null,
      status: 'planned',
      published: false,
      createdByUserId: world.northstar.owner.id,
    }),
  );
  return row.id;
}

/** An objective on a Northstar project. */
async function newObjective(projectId: string, name: string): Promise<string> {
  const row = await tenant.transaction(northstar, (tx) =>
    objectives.create(tx, northstar, {
      projectId,
      name,
      status: 'open',
      createdBy: world.northstar.owner.id,
    }),
  );
  return row.id;
}

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
  northstarPrincipal = ownerPrincipal(
    world.northstar.organizationId,
    world.northstar.owner.id,
    world.northstar.owner.membershipId,
  );

  keyResultsService = new KeyResultsService(tenant);
  dependenciesService = new ProjectDependenciesService(tenant);
  customFieldsService = new ProjectCustomFieldsService(tenant);
  retroNotesService = new ProjectRetroNotesService(tenant);
  milestoneLinksService = new MilestoneLinksService(tenant);
});

afterAll(async () => {
  await db?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Each child table scopes to its project's org (twin → 0 rows / null).
// ─────────────────────────────────────────────────────────────────────────────

describe('every Projects child table scopes to its own tenant', () => {
  it('a milestone created in the twin is invisible through a Northstar context', async () => {
    const twinMilestone = await tenant.transaction(twin, (tx) =>
      milestones.create(tx, twin, {
        projectId: world.twin.projectId,
        title: 'Twin launch',
        dueOn: null,
        status: 'planned',
        published: true,
        createdByUserId: world.twin.owner.id,
      }),
    );

    // The twin's project id resolved under Northstar lists nothing, and a direct id lookup is null.
    const listed = await tenant.read(northstar, (tx) =>
      milestones.list(tx, northstar, { projectId: world.twin.projectId, publishedOnly: false }),
    );
    expect(listed).toHaveLength(0);
    const found = await tenant.read(northstar, (tx) =>
      milestones.findById(tx, northstar, twinMilestone.id),
    );
    expect(found).toBeNull();
    // But the row genuinely exists for its own tenant — the predicate, not an absent row, hid it.
    const forTwin = await tenant.read(twin, (tx) =>
      milestones.findById(tx, twin, twinMilestone.id),
    );
    expect(forTwin?.id).toBe(twinMilestone.id);
  });

  it('a key result, internal risk, dependency, custom-field value and retro note are each twin-scoped', async () => {
    // Build one row of each kind in the twin tenant, then prove none is visible to Northstar.
    const twinObjective = await tenant.transaction(twin, (tx) =>
      objectives.create(tx, twin, {
        projectId: world.twin.projectId,
        name: 'Twin objective',
        status: 'open',
        createdBy: world.twin.owner.id,
      }),
    );
    const twinKr = await tenant.transaction(twin, (tx) =>
      keyResults.create(tx, twin, {
        objectiveId: twinObjective.id,
        title: 'Twin KR',
        targetValue: 100,
        currentValue: 10,
        unit: '%',
        createdBy: world.twin.owner.id,
      }),
    );
    const twinRisk = await tenant.transaction(twin, (tx) =>
      risks.create(tx, twin, {
        projectId: world.twin.projectId,
        title: 'Twin risk',
        likelihood: 'high',
        impact: 'high',
        status: 'open',
        createdBy: world.twin.owner.id,
      }),
    );
    const twinNote = await tenant.transaction(twin, (tx) =>
      retroNotes.create(tx, twin, {
        projectId: world.twin.projectId,
        milestoneId: null,
        category: 'went_well',
        body: 'Twin retro',
        createdBy: world.twin.owner.id,
      }),
    );
    await tenant.transaction(twin, (tx) =>
      customFields.createDefinition(tx, twin, {
        fieldKey: 'twin_only',
        name: 'Twin only',
        fieldType: 'text',
      }),
    );
    await tenant.transaction(twin, (tx) =>
      customFields.setValue(tx, twin, {
        projectId: world.twin.projectId,
        fieldKey: 'twin_only',
        valueText: 'secret',
      }),
    );

    // Northstar sees none of them.
    expect(
      await tenant.read(northstar, (tx) =>
        keyResults.list(tx, northstar, { objectiveId: twinObjective.id }),
      ),
    ).toHaveLength(0);
    expect(
      await tenant.read(northstar, (tx) => keyResults.findById(tx, northstar, twinKr.id)),
    ).toBeNull();
    expect(
      await tenant.read(northstar, (tx) =>
        risks.list(tx, northstar, { projectId: world.twin.projectId }),
      ),
    ).toHaveLength(0);
    expect(
      await tenant.read(northstar, (tx) => risks.findById(tx, northstar, twinRisk.id)),
    ).toBeNull();
    expect(
      await tenant.read(northstar, (tx) =>
        retroNotes.listByProject(tx, northstar, world.twin.projectId),
      ),
    ).toHaveLength(0);
    expect(
      await tenant.read(northstar, (tx) => retroNotes.findById(tx, northstar, twinNote.id)),
    ).toBeNull();
    expect(
      await tenant.read(northstar, (tx) => customFields.listDefinitions(tx, northstar)),
    ).toHaveLength(0);
    expect(
      await tenant.read(northstar, (tx) =>
        customFields.listValues(tx, northstar, world.twin.projectId),
      ),
    ).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. A child can never name a parent in another org (composite FK / service 404).
// ─────────────────────────────────────────────────────────────────────────────

describe('a child cannot reference a parent in another org', () => {
  it('the composite foreign keys refuse a cross-tenant project/objective pair', async () => {
    // Each uses Northstar's org id with the twin's parent id — a pair that does not exist, even
    // though both ids exist individually. The admin session bypasses the application layers, so the
    // key itself must refuse.
    const twinObjective = await tenant.transaction(twin, (tx) =>
      objectives.create(tx, twin, {
        projectId: world.twin.projectId,
        name: 'Twin objective for FK',
        status: 'open',
        createdBy: world.twin.owner.id,
      }),
    );

    await expect(
      db.admin.execute(
        `insert into project_milestones
           (id, organization_id, project_id, title, status, published, created_by_user_id)
         values (?, ?, ?, 'x', 'planned', 0, ?)`,
        [uuidv7(), world.northstar.organizationId, world.twin.projectId, world.northstar.owner.id],
      ),
    ).rejects.toThrow(FK_FAILS);

    await expect(
      db.admin.execute(
        `insert into project_internal_risks
           (id, organization_id, project_id, title, likelihood, impact, status, created_by)
         values (?, ?, ?, 'x', 'medium', 'medium', 'open', ?)`,
        [uuidv7(), world.northstar.organizationId, world.twin.projectId, world.northstar.owner.id],
      ),
    ).rejects.toThrow(FK_FAILS);

    await expect(
      db.admin.execute(
        `insert into objective_key_results
           (id, organization_id, objective_id, title, target_value, current_value, unit, created_by)
         values (?, ?, ?, 'x', 100, 0, '%', ?)`,
        [uuidv7(), world.northstar.organizationId, twinObjective.id, world.northstar.owner.id],
      ),
    ).rejects.toThrow(FK_FAILS);

    await expect(
      db.admin.execute(
        `insert into project_dependencies
           (id, organization_id, blocker_project_id, blocked_project_id, created_by)
         values (?, ?, ?, ?, ?)`,
        [
          uuidv7(),
          world.northstar.organizationId,
          world.northstar.projectId,
          world.twin.projectId,
          world.northstar.owner.id,
        ],
      ),
    ).rejects.toThrow(FK_FAILS);

    await expect(
      db.admin.execute(
        `insert into project_retro_notes
           (id, organization_id, project_id, category, body, created_by)
         values (?, ?, ?, 'action', 'x', ?)`,
        [uuidv7(), world.northstar.organizationId, world.twin.projectId, world.northstar.owner.id],
      ),
    ).rejects.toThrow(FK_FAILS);
  });

  it('a custom-field value against a cross-tenant project is a 404, not a dangling row', async () => {
    // A value's project has no composite FK (the service resolves it); so the tenant safety is the
    // service's, and a twin project id under Northstar is a 404 with nothing written.
    await tenant.transaction(northstar, (tx) =>
      customFields.createDefinition(tx, northstar, {
        fieldKey: 'client_tier',
        name: 'Client tier',
        fieldType: 'text',
      }),
    );
    await expectApiError(
      customFieldsService.setValue(northstar, northstarPrincipal, {
        projectId: world.twin.projectId,
        fieldKey: 'client_tier',
        value: 'gold',
      }),
      404,
    );
    // The dangling row the bug would write carries the acting (Northstar) org and the twin project;
    // scope the probe to that pair so the twin's own legitimate value row is not counted.
    const rows = await observe(
      `select count(*) as n from project_custom_fields
        where organization_id = ? and row_kind = 'value' and project_id = ?`,
      [world.northstar.organizationId, world.twin.projectId],
    );
    expect(Number(rows[0]?.['n'])).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Dependency invariants: milestone links (acyclic) and project edges (self/dup).
// ─────────────────────────────────────────────────────────────────────────────

describe('milestone dependency links refuse self-links and cycles', () => {
  let a: string;
  let b: string;
  let c: string;

  it('links a prerequisite, then refuses the self-link, the direct cycle and the transitive cycle', async () => {
    a = await newMilestone(world.northstar.projectId, 'Design sign-off');
    b = await newMilestone(world.northstar.projectId, 'Build complete');
    c = await newMilestone(world.northstar.projectId, 'Launch');

    // a → b, b → c stand.
    const edge = await milestoneLinksService.link(northstar, northstarPrincipal, {
      milestoneId: a,
      dependsOnMilestoneId: b,
    });
    expect(edge.milestoneId).toBe(a);
    expect(edge.dependsOnMilestoneId).toBe(b);
    await milestoneLinksService.link(northstar, northstarPrincipal, {
      milestoneId: b,
      dependsOnMilestoneId: c,
    });

    // A self-link is a 400.
    await expectApiError(
      milestoneLinksService.link(northstar, northstarPrincipal, {
        milestoneId: a,
        dependsOnMilestoneId: a,
      }),
      400,
    );
    // The direct reversal b → a closes a 1-hop cycle (a → b already exists): 400.
    await expectApiError(
      milestoneLinksService.link(northstar, northstarPrincipal, {
        milestoneId: b,
        dependsOnMilestoneId: a,
      }),
      400,
    );
    // The transitive cycle c → a (a → b → c already reaches c): a single-row check cannot see it.
    await expectApiError(
      milestoneLinksService.link(northstar, northstarPrincipal, {
        milestoneId: c,
        dependsOnMilestoneId: a,
      }),
      400,
    );
  });

  it('refuses a prerequisite in another project of the same tenant, and in the twin', async () => {
    const otherProjectMilestone = await newMilestone(
      world.northstar.otherProjectId,
      'Brand refresh gate',
    );
    // Cross-project within the tenant: a milestone dependency is project-scoped (404).
    await expectApiError(
      milestoneLinksService.link(northstar, northstarPrincipal, {
        milestoneId: a,
        dependsOnMilestoneId: otherProjectMilestone,
      }),
      404,
    );
    // Cross-tenant: the twin's milestone is indistinguishable from one that does not exist (404).
    const twinMilestone = await tenant.transaction(twin, (tx) =>
      milestones.create(tx, twin, {
        projectId: world.twin.projectId,
        title: 'Twin gate',
        dueOn: null,
        status: 'planned',
        published: false,
        createdByUserId: world.twin.owner.id,
      }),
    );
    await expectApiError(
      milestoneLinksService.link(northstar, northstarPrincipal, {
        milestoneId: a,
        dependsOnMilestoneId: twinMilestone.id,
      }),
      404,
    );
  });
});

describe('project dependency edges refuse a self-edge and a duplicate', () => {
  it('creates an edge, refuses the self-edge (400), the duplicate (409) and the cross-tenant end (404)', async () => {
    const edge = await dependenciesService.create(northstar, northstarPrincipal, {
      blockerProjectId: world.northstar.projectId,
      blockedProjectId: world.northstar.otherProjectId,
    });
    expect(edge.blockerProjectId).toBe(world.northstar.projectId);
    expect(edge.blockedProjectId).toBe(world.northstar.otherProjectId);

    // Self-edge: 400.
    await expectApiError(
      dependenciesService.create(northstar, northstarPrincipal, {
        blockerProjectId: world.northstar.projectId,
        blockedProjectId: world.northstar.projectId,
      }),
      400,
    );
    // Duplicate pair: 409.
    await expectApiError(
      dependenciesService.create(northstar, northstarPrincipal, {
        blockerProjectId: world.northstar.projectId,
        blockedProjectId: world.northstar.otherProjectId,
      }),
      409,
    );
    // A blocked project in the twin is a 404 (resolved tenant-scoped before the write).
    await expectApiError(
      dependenciesService.create(northstar, northstarPrincipal, {
        blockerProjectId: world.northstar.projectId,
        blockedProjectId: world.twin.projectId,
      }),
      404,
    );
  });

  it('permits the reverse edge: project dependencies are deliberately not acyclic (0177)', async () => {
    // Unlike milestone links, 0177 guards only self/duplicate — a reverse edge is a legitimate second
    // row. Characterised here so the contrast is on the record and a future cycle guard is a conscious
    // change, not a silent one.
    const reverse = await dependenciesService.create(northstar, northstarPrincipal, {
      blockerProjectId: world.northstar.otherProjectId,
      blockedProjectId: world.northstar.projectId,
    });
    expect(reverse.blockerProjectId).toBe(world.northstar.otherProjectId);
    expect(reverse.blockedProjectId).toBe(world.northstar.projectId);

    const pair = await observe(
      `select count(*) as n from project_dependencies where organization_id = ?`,
      [world.northstar.organizationId],
    );
    expect(Number(pair[0]?.['n'])).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. A key result ties to an objective in the same org; progress is computed.
// ─────────────────────────────────────────────────────────────────────────────

describe('a key result ties to an objective in the same org', () => {
  it('creates under a Northstar objective and computes bounded progress', async () => {
    const objectiveId = await newObjective(world.northstar.projectId, 'Grow activation');
    const kr = await keyResultsService.create(northstar, northstarPrincipal, {
      objectiveId,
      title: 'Trial-to-paid conversion',
      targetValue: 50,
      currentValue: 10,
      unit: '%',
    });
    expect(kr.objectiveId).toBe(objectiveId);
    // Computed, not stored: 10 / 50 = 20%.
    expect(kr.progressPercent).toBe(20);

    // An over-achieving current caps at 100 rather than exceeding it.
    const updated = await keyResultsService.update(
      northstar,
      northstarPrincipal,
      objectiveId,
      kr.id,
      {
        currentValue: 500,
      },
    );
    expect(updated.progressPercent).toBe(100);
  });

  it('refuses a key result under an objective in another org (404), and the FK is the backstop', async () => {
    const twinObjective = await tenant.transaction(twin, (tx) =>
      objectives.create(tx, twin, {
        projectId: world.twin.projectId,
        name: 'Twin objective for KR tie',
        status: 'open',
        createdBy: world.twin.owner.id,
      }),
    );
    // The service resolves the objective under the acting tenant first: a twin objective is a 404.
    await expectApiError(
      keyResultsService.create(northstar, northstarPrincipal, {
        objectiveId: twinObjective.id,
        title: 'Cross-org KR',
        targetValue: 10,
        currentValue: 1,
        unit: '%',
      }),
      404,
    );
    // Nothing was written against the twin objective by the refused Northstar call.
    const rows = await observe(
      `select count(*) as n from objective_key_results where objective_id = ?`,
      [twinObjective.id],
    );
    expect(Number(rows[0]?.['n'])).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. A custom-field value matches its field's type.
// ─────────────────────────────────────────────────────────────────────────────

describe('a custom-field value is validated against its field type', () => {
  it('a number field refuses a non-numeric value and accepts a numeric one', async () => {
    await tenant.transaction(northstar, (tx) =>
      customFields.createDefinition(tx, northstar, {
        fieldKey: 'team_size',
        name: 'Team size',
        fieldType: 'number',
      }),
    );
    await expectApiError(
      customFieldsService.setValue(northstar, northstarPrincipal, {
        projectId: world.northstar.projectId,
        fieldKey: 'team_size',
        value: 'not-a-number',
      }),
      400,
    );
    const ok = await customFieldsService.setValue(northstar, northstarPrincipal, {
      projectId: world.northstar.projectId,
      fieldKey: 'team_size',
      value: '7',
    });
    expect(ok.value).toBe('7');
  });

  it('a select field refuses a value outside its options and accepts a declared one', async () => {
    await tenant.transaction(northstar, (tx) =>
      customFields.createDefinition(tx, northstar, {
        fieldKey: 'tier',
        name: 'Tier',
        fieldType: 'select',
        options: ['bronze', 'silver', 'gold'],
      }),
    );
    await expectApiError(
      customFieldsService.setValue(northstar, northstarPrincipal, {
        projectId: world.northstar.projectId,
        fieldKey: 'tier',
        value: 'platinum',
      }),
      400,
    );
    const ok = await customFieldsService.setValue(northstar, northstarPrincipal, {
      projectId: world.northstar.projectId,
      fieldKey: 'tier',
      value: 'gold',
    });
    expect(ok.value).toBe('gold');

    // The upsert moves the value in place rather than writing a second row.
    const again = await customFieldsService.setValue(northstar, northstarPrincipal, {
      projectId: world.northstar.projectId,
      fieldKey: 'tier',
      value: 'silver',
    });
    expect(again.value).toBe('silver');
    const count = await observe(
      `select count(*) as n from project_custom_fields
        where organization_id = ? and row_kind = 'value' and project_id = ? and field_key = 'tier'`,
      [world.northstar.organizationId, world.northstar.projectId],
    );
    expect(Number(count[0]?.['n'])).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Retro notes: append-and-delete only, scoped, milestone must match project.
// ─────────────────────────────────────────────────────────────────────────────

describe('a retro note is append-and-delete only', () => {
  it('captures notes, lists newest-first, and deletes one scoped — a cross-tenant id removes nothing', async () => {
    const first = await retroNotesService.create(northstar, northstarPrincipal, {
      projectId: world.northstar.projectId,
      milestoneId: null,
      category: 'went_well',
      body: 'Shipped on time',
    });
    const second = await retroNotesService.create(northstar, northstarPrincipal, {
      projectId: world.northstar.projectId,
      milestoneId: null,
      category: 'to_improve',
      body: 'Tighten the handoff',
    });

    const board = await retroNotesService.list(
      northstar,
      northstarPrincipal,
      world.northstar.projectId,
    );
    expect(board.wentWell.map((n) => n.id)).toContain(first.id);
    expect(board.toImprove.map((n) => n.id)).toContain(second.id);

    // A twin note id deleted under Northstar removes nothing (idempotent, scoped) and leaves it be.
    const twinNote = await tenant.transaction(twin, (tx) =>
      retroNotes.create(tx, twin, {
        projectId: world.twin.projectId,
        milestoneId: null,
        category: 'action',
        body: 'Twin follow-up',
        createdBy: world.twin.owner.id,
      }),
    );
    await retroNotesService.delete(
      northstar,
      northstarPrincipal,
      world.northstar.projectId,
      twinNote.id,
    );
    const stillThere = await tenant.read(twin, (tx) => retroNotes.findById(tx, twin, twinNote.id));
    expect(stillThere?.id).toBe(twinNote.id);

    // Deleting a Northstar note removes exactly that one; the other stands.
    await retroNotesService.delete(
      northstar,
      northstarPrincipal,
      world.northstar.projectId,
      first.id,
    );
    const after = await tenant.read(northstar, (tx) =>
      retroNotes.listByProject(tx, northstar, world.northstar.projectId),
    );
    const ids = after.map((n) => n.id);
    expect(ids).not.toContain(first.id);
    expect(ids).toContain(second.id);
  });

  it('refuses a milestone that belongs to another project (400)', async () => {
    const otherMilestone = await newMilestone(world.northstar.otherProjectId, 'Other-project gate');
    await expectApiError(
      retroNotesService.create(northstar, northstarPrincipal, {
        projectId: world.northstar.projectId,
        milestoneId: otherMilestone,
        category: 'action',
        body: 'Mismatched milestone',
      }),
      400,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Identity is immutable at the engine (BEFORE UPDATE triggers).
// ─────────────────────────────────────────────────────────────────────────────

describe('identity columns are immutable at the engine', () => {
  it('a milestone cannot be re-pointed at another project', async () => {
    const milestoneId = await newMilestone(world.northstar.projectId, 'Immutable milestone');
    await expect(
      db.admin.execute(`update project_milestones set project_id = ? where id = ?`, [
        world.northstar.otherProjectId,
        milestoneId,
      ]),
    ).rejects.toThrow(IMMUTABLE);
  });

  it('a key result cannot be re-pointed at another objective', async () => {
    const objectiveId = await newObjective(world.northstar.projectId, 'KR pin objective');
    const otherObjectiveId = await newObjective(world.northstar.projectId, 'KR pin objective 2');
    const kr = await keyResultsService.create(northstar, northstarPrincipal, {
      objectiveId,
      title: 'Pinned KR',
      targetValue: 10,
      currentValue: 1,
      unit: '%',
    });
    await expect(
      db.admin.execute(`update objective_key_results set objective_id = ? where id = ?`, [
        otherObjectiveId,
        kr.id,
      ]),
    ).rejects.toThrow(IMMUTABLE);
  });

  it('an internal risk cannot be re-pointed at another project', async () => {
    const risk = await tenant.transaction(northstar, (tx) =>
      risks.create(tx, northstar, {
        projectId: world.northstar.projectId,
        title: 'Pinned risk',
        likelihood: 'medium',
        impact: 'high',
        status: 'open',
        createdBy: world.northstar.owner.id,
      }),
    );
    await expect(
      db.admin.execute(`update project_internal_risks set project_id = ? where id = ?`, [
        world.northstar.otherProjectId,
        risk.id,
      ]),
    ).rejects.toThrow(IMMUTABLE);
  });

  it('a custom-field value cannot change its project or key', async () => {
    await tenant.transaction(northstar, (tx) =>
      customFields.createDefinition(tx, northstar, {
        fieldKey: 'region',
        name: 'Region',
        fieldType: 'text',
      }),
    );
    const value = await customFieldsService.setValue(northstar, northstarPrincipal, {
      projectId: world.northstar.projectId,
      fieldKey: 'region',
      value: 'EMEA',
    });
    const row = await observe(
      `select id from project_custom_fields
        where organization_id = ? and row_kind = 'value' and project_id = ? and field_key = 'region'`,
      [world.northstar.organizationId, world.northstar.projectId],
    );
    const valueId = String(row[0]?.['id']);
    expect(value.value).toBe('EMEA');
    await expect(
      db.admin.execute(`update project_custom_fields set project_id = ? where id = ?`, [
        world.northstar.otherProjectId,
        valueId,
      ]),
    ).rejects.toThrow(IMMUTABLE);
    await expect(
      db.admin.execute(`update project_custom_fields set field_key = 'moved' where id = ?`, [
        valueId,
      ]),
    ).rejects.toThrow(IMMUTABLE);
  });
});
