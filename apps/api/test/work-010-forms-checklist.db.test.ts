import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { AuditEventsRepository } from '../src/modules/audit/audit-events.repository.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { OutboxEventsRepository } from '../src/modules/platform/outbox-events.repository.js';
import { ProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { WorkItemsRepository } from '../src/modules/work/work-items.repository.js';
import { WorkGraphRepository } from '../src/modules/work/work-graph.repository.js';
import { WorkItemsService } from '../src/modules/work/work-items.service.js';
import type { WorkItemView } from '../src/modules/work/work-items.service.js';
import { WorkChecklistRepository } from '../src/modules/work/work-checklist.repository.js';
import { WorkCommentsRepository } from '../src/modules/work/work-comments.repository.js';
import { WorkItemLinksRepository } from '../src/modules/work/item-links.repository.js';
import { WorkItemFilesRepository } from '../src/modules/work/item-files.repository.js';
import { WorkFormsRepository } from '../src/modules/work/work-forms.repository.js';
import { validateSubmissionValues } from '../src/modules/work/work-forms.validate.js';
import { ApiError } from '../src/common/http/errors.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * WORK-010 against a real server — the Work additions built since the work-journeys proof covered
 * only list and board (module 7's checklist, intake forms, comments, typed links, and file
 * attachments). What only this suite can prove, and `work-00*.db.test.ts` does not:
 *
 * 1. **Each child scopes to its work item's org.** Every one of the five tables carries a composite
 *    foreign key that pins its parent to `(organization_id, …)`. The adversarial twin shares the
 *    identical work-item title and an id one hex digit away, so a child written in the twin never
 *    reads back for Northstar, and a child *written for Northstar that names the twin's parent* is
 *    refused by the engine, not merely by the service — a cross-tenant parent is a non-existent
 *    pair, not a leak and not a foreign-key 500 the caller can tell apart from a 404.
 * 2. **Checklist ordering and done-state persist.** `position` is seeded one past the current
 *    highest, the list reads back in that order, and a toggle/rename round-trips while the identity
 *    columns are refused by the 0051 trigger.
 * 3. **A form submission is validated against the schema stored in the database.** An invalid
 *    payload (missing a required field, a wrong-typed value, an undeclared field) is rejected and
 *    *no work item is written*; a valid payload creates exactly one — the controller's own order
 *    (validate, then create), exercised against a form read back from MySQL.
 * 4. **A typed link's type and direction persist**, the duplicate typed pair is refused by
 *    `uq_work_item_links_edge`, the self-link by the 0085 insert trigger, and the row is immutable.
 * 5. **A file attachment references an owned file row only** — the 0086 composite keys refuse a
 *    cross-tenant file id and a cross-tenant work-item id alike, and a pair attaches at most once.
 *
 * Fixtures are built through the repositories under test and (for the parent rows and file assets)
 * the admin pool, exactly as `seed-two-tenants.ts` does — never editing the seed. The admin pool's
 * clock is SYSTEM, so every admin-written timestamp is a bound `new Date(...)`, never the
 * connection's `current_timestamp`.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let northstar: TenantContext;
let twin: TenantContext;
let owner: Principal;
let twinOwner: Principal;
let work: WorkItemsService;

const checklist = new WorkChecklistRepository();
const comments = new WorkCommentsRepository();
const links = new WorkItemLinksRepository();
const files = new WorkItemFilesRepository();
const forms = new WorkFormsRepository();

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

const ownerPrincipal = (context: TenantContext): Principal => ({
  userId: context.userId,
  organizationId: context.organizationId,
  kind: 'internal',
  role: 'owner',
  membershipId: context.membershipId,
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
});

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

/** Mint a work item on Northstar's Atlas project, through the real service (org-wide owner). */
async function newItem(title: string): Promise<string> {
  const view = await work.create(northstar, owner, {
    projectId: world.northstar.projectId,
    title,
  });
  return view.id;
}

/**
 * Place a `ready` file asset directly, the way `seed-two-tenants` places parents: through the admin
 * pool, with a bound `Date` for the SYSTEM-clock columns. `purpose`/`status`/`audience` are the
 * smallest valid shape FILE-001 leaves behind.
 */
async function insertFileAsset(
  organizationId: string,
  projectId: string,
  ownerUserId: string,
  name: string,
): Promise<string> {
  const id = uuidv7();
  const now = new Date();
  await db.admin.execute(
    `insert into file_assets
       (id, organization_id, project_id, owner_user_id, name, purpose, audience, status,
        version, created_at, updated_at)
     values (?, ?, ?, ?, ?, 'deliverable', 'internal', 'ready', 1, ?, ?)`,
    [id, organizationId, projectId, ownerUserId, name, now, now],
  );
  return id;
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
  owner = ownerPrincipal(northstar);
  twinOwner = ownerPrincipal(twin);

  const audit = new AuditService(tenant, new AuditEventsRepository());
  work = new WorkItemsService(
    tenant,
    new WorkItemsRepository(),
    audit,
    new ProjectsRepository(),
    new OutboxEventsRepository(),
    new WorkGraphRepository(),
  );
});

afterAll(async () => {
  await db?.stop();
});

describe('checklist items', () => {
  it('append in order, and a toggle + rename round-trips', async () => {
    const itemId = await newItem('Harden the booking funnel');

    const first = await tenant.transaction(northstar, (tx) =>
      checklist.create(tx, northstar, { workItemId: itemId, label: 'Draft the copy' }),
    );
    const second = await tenant.transaction(northstar, (tx) =>
      checklist.create(tx, northstar, { workItemId: itemId, label: 'Wire the form' }),
    );
    const third = await tenant.transaction(northstar, (tx) =>
      checklist.create(tx, northstar, { workItemId: itemId, label: 'Ship it' }),
    );

    // Position is seeded one past the current highest, so insertion order is the read order.
    expect([first.position, second.position, third.position]).toEqual([0, 1, 2]);
    expect(first.done).toBe(false);

    const listed = await tenant.read(northstar, (tx) =>
      checklist.listForWorkItem(tx, northstar, itemId),
    );
    expect(listed.map((row) => row.label)).toEqual(['Draft the copy', 'Wire the form', 'Ship it']);

    // Toggle done and rename in place; both persist, identity is untouched.
    const updated = await tenant.transaction(northstar, (tx) =>
      checklist.update(tx, northstar, itemId, second.id, {
        done: true,
        label: 'Wire the intake form',
      }),
    );
    expect(updated?.done).toBe(true);
    expect(updated?.label).toBe('Wire the intake form');

    const reread = await tenant.read(northstar, (tx) =>
      checklist.findItem(tx, northstar, itemId, second.id),
    );
    expect(reread?.done).toBe(true);
    expect(reread?.label).toBe('Wire the intake form');
    // The other items are undisturbed and still ordered.
    const after = await tenant.read(northstar, (tx) =>
      checklist.listForWorkItem(tx, northstar, itemId),
    );
    expect(after.map((row) => row.position)).toEqual([0, 1, 2]);
  });

  it('cannot attach to a work item in another org (composite foreign key)', async () => {
    // Northstar's credential, naming the twin's parent: the repo writes org = Northstar, parent =
    // the twin's item, which is not a pair in work_items and the engine refuses.
    await expect(
      tenant.transaction(northstar, (tx) =>
        checklist.create(tx, northstar, {
          workItemId: world.twin.workItemId,
          label: 'should never persist',
        }),
      ),
    ).rejects.toThrow(/foreign key constraint fails/i);
  });

  it('does not read another org’s checklist items, even by id', async () => {
    const twinItem = world.twin.workItemId;
    const twinRow = await tenant.transaction(twin, (tx) =>
      checklist.create(tx, twin, { workItemId: twinItem, label: 'Twin only' }),
    );

    // Northstar sees nothing for the twin's item, and resolving the id directly is null.
    const asNorthstar = await tenant.read(northstar, (tx) =>
      checklist.listForWorkItem(tx, northstar, twinItem),
    );
    expect(asNorthstar).toHaveLength(0);
    const byId = await tenant.read(northstar, (tx) =>
      checklist.findItem(tx, northstar, twinItem, twinRow.id),
    );
    expect(byId).toBeNull();
    // It genuinely exists for its own tenant.
    const reallyExists = await tenant.read(twin, (tx) =>
      checklist.findItem(tx, twin, twinItem, twinRow.id),
    );
    expect(reallyExists?.id).toBe(twinRow.id);
  });

  it('refuses to re-parent or re-tenant a checklist item (0051 trigger)', async () => {
    const itemId = await newItem('Checklist identity is pinned');
    const row = await tenant.transaction(northstar, (tx) =>
      checklist.create(tx, northstar, { workItemId: itemId, label: 'immutable identity' }),
    );
    await expect(
      db.admin.execute('update work_item_checklist_items set work_item_id = ? where id = ?', [
        world.northstar.workItemId,
        row.id,
      ]),
    ).rejects.toThrow(/work_item_id is immutable/);
    await expect(
      db.admin.execute('update work_item_checklist_items set organization_id = ? where id = ?', [
        world.twin.organizationId,
        row.id,
      ]),
    ).rejects.toThrow(/organization_id is immutable/);
  });
});

describe('work item comments', () => {
  it('append in created-at order and never cross a tenant', async () => {
    const itemId = await newItem('Discuss the launch');
    const a = await tenant.transaction(northstar, (tx) =>
      comments.create(tx, northstar, {
        workItemId: itemId,
        authorMembershipId: world.northstar.owner.membershipId,
        body: 'First, the scope.',
      }),
    );
    const b = await tenant.transaction(northstar, (tx) =>
      comments.create(tx, northstar, {
        workItemId: itemId,
        authorMembershipId: world.northstar.manager.membershipId,
        body: 'Then, the dates.',
      }),
    );
    expect(a.id).not.toBe(b.id);

    const listed = await tenant.read(northstar, (tx) =>
      comments.listForWorkItem(tx, northstar, itemId),
    );
    expect(listed.map((row) => row.body)).toEqual(['First, the scope.', 'Then, the dates.']);

    // The twin's comment on its own item is invisible to Northstar.
    const twinComment = await tenant.transaction(twin, (tx) =>
      comments.create(tx, twin, {
        workItemId: world.twin.workItemId,
        authorMembershipId: world.twin.owner.membershipId,
        body: 'Twin discussion',
      }),
    );
    const asNorthstar = await tenant.read(northstar, (tx) =>
      comments.findComment(tx, northstar, world.twin.workItemId, twinComment.id),
    );
    expect(asNorthstar).toBeNull();

    // W-WEB-1 leftover: the author is named through this tenant's memberships only; the twin's
    // membership does not resolve for Northstar.
    const authors = await tenant.read(northstar, (tx) =>
      comments.authors(tx, northstar, [
        world.northstar.owner.membershipId,
        world.twin.owner.membershipId,
      ]),
    );
    expect(authors.map((row) => row.membershipId)).toEqual([world.northstar.owner.membershipId]);
    expect(authors[0]?.displayName).toBeTruthy();
  });

  it('cannot comment on a work item in another org (composite foreign key)', async () => {
    await expect(
      tenant.transaction(northstar, (tx) =>
        comments.create(tx, northstar, {
          workItemId: world.twin.workItemId,
          authorMembershipId: world.northstar.owner.membershipId,
          body: 'should never persist',
        }),
      ),
    ).rejects.toThrow(/foreign key constraint fails/i);
  });

  it('is append-only: the engine refuses any amendment (0053 trigger)', async () => {
    const itemId = await newItem('Comments are a record');
    const row = await tenant.transaction(northstar, (tx) =>
      comments.create(tx, northstar, {
        workItemId: itemId,
        authorMembershipId: world.northstar.owner.membershipId,
        body: 'as it was said',
      }),
    );
    await expect(
      db.admin.execute('update work_item_comments set body = ? where id = ?', [
        'rewritten',
        row.id,
      ]),
    ).rejects.toThrow(/append-only/);
  });
});

describe('typed work item links', () => {
  it('persist type and direction, and join the target’s title and state', async () => {
    const from = await newItem('Design the checkout');
    const to = await newItem('Approve the payment vendor');

    const blocks = await tenant.transaction(northstar, (tx) =>
      links.create(tx, northstar, {
        fromWorkItemId: from,
        toWorkItemId: to,
        linkType: 'blocks',
        createdByUserId: world.northstar.owner.id,
      }),
    );
    expect(blocks.fromWorkItemId).toBe(from);
    expect(blocks.toWorkItemId).toBe(to);
    expect(blocks.linkType).toBe('blocks');

    const projected = await tenant.read(northstar, (tx) => links.listFromItem(tx, northstar, from));
    expect(projected).toHaveLength(1);
    expect(projected[0]?.link.linkType).toBe('blocks');
    expect(projected[0]?.toWorkItemTitle).toBe('Approve the payment vendor');
    expect(projected[0]?.toWorkItemState).toBe('backlog');

    // A reversed, differently-typed edge is a different fact and is allowed.
    const relates = await tenant.transaction(northstar, (tx) =>
      links.create(tx, northstar, {
        fromWorkItemId: to,
        toWorkItemId: from,
        linkType: 'relates',
        createdByUserId: world.northstar.owner.id,
      }),
    );
    expect(relates.linkType).toBe('relates');
  });

  it('refuses the duplicate typed pair, the self-link, and any UPDATE (0085)', async () => {
    const from = await newItem('Build the API');
    const to = await newItem('Finalize the contract');
    const edge = await tenant.transaction(northstar, (tx) =>
      links.create(tx, northstar, {
        fromWorkItemId: from,
        toWorkItemId: to,
        linkType: 'blocks',
        createdByUserId: world.northstar.owner.id,
      }),
    );

    // Same (org, from, to, type) a second time: refused by uq_work_item_links_edge.
    await expect(
      tenant.transaction(northstar, (tx) =>
        links.create(tx, northstar, {
          fromWorkItemId: from,
          toWorkItemId: to,
          linkType: 'blocks',
          createdByUserId: world.northstar.owner.id,
        }),
      ),
    ).rejects.toThrow(/Duplicate entry/);

    // A self-link is refused by the BEFORE INSERT trigger.
    await expect(
      tenant.transaction(northstar, (tx) =>
        links.create(tx, northstar, {
          fromWorkItemId: from,
          toWorkItemId: from,
          linkType: 'relates',
          createdByUserId: world.northstar.owner.id,
        }),
      ),
    ).rejects.toThrow(/cannot link to itself/);

    // A typed edge is immutable: correcting one is delete-and-add.
    await expect(
      db.admin.execute('update work_item_links set link_type = ? where id = ?', [
        'relates',
        edge.id,
      ]),
    ).rejects.toThrow(/immutable/);
  });

  it('refuses an endpoint in another org and never resolves a twin’s link', async () => {
    const from = await newItem('Local item');
    // Northstar's credential, pointing at the twin's item: fk_work_item_links_to has no such pair.
    await expect(
      tenant.transaction(northstar, (tx) =>
        links.create(tx, northstar, {
          fromWorkItemId: from,
          toWorkItemId: world.twin.workItemId,
          linkType: 'relates',
          createdByUserId: world.northstar.owner.id,
        }),
      ),
    ).rejects.toThrow(/foreign key constraint fails/i);

    // A link that genuinely exists in the twin does not resolve under Northstar.
    const twinFrom = world.twin.workItemId;
    const twinTo = await work.create(twin, twinOwner, {
      projectId: world.twin.projectId,
      title: 'Twin target',
    });
    const twinLink = await tenant.transaction(twin, (tx) =>
      links.create(tx, twin, {
        fromWorkItemId: twinFrom,
        toWorkItemId: twinTo.id,
        linkType: 'blocks',
        createdByUserId: world.twin.owner.id,
      }),
    );
    const asNorthstar = await tenant.read(northstar, (tx) =>
      links.findById(tx, northstar, twinLink.id),
    );
    expect(asNorthstar).toBeNull();
  });
});

describe('work item file attachments', () => {
  it('attach an owned file, list it with its name, and never cross a tenant', async () => {
    const itemId = await newItem('Attach the brand assets');
    const fileId = await insertFileAsset(
      world.northstar.organizationId,
      world.northstar.projectId,
      world.northstar.owner.id,
      'brand-guidelines.pdf',
    );

    const link = await tenant.transaction(northstar, (tx) =>
      files.create(tx, northstar, {
        workItemId: itemId,
        fileAssetId: fileId,
        attachedByMembershipId: world.northstar.owner.membershipId,
      }),
    );
    expect(link.fileAssetId).toBe(fileId);

    const listed = await tenant.read(northstar, (tx) =>
      files.listForWorkItem(tx, northstar, itemId),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.fileName).toBe('brand-guidelines.pdf');

    // The twin's attachment on its own item is invisible to Northstar.
    const twinFile = await insertFileAsset(
      world.twin.organizationId,
      world.twin.projectId,
      world.twin.owner.id,
      'twin-secret.pdf',
    );
    const twinLink = await tenant.transaction(twin, (tx) =>
      files.create(tx, twin, {
        workItemId: world.twin.workItemId,
        fileAssetId: twinFile,
        attachedByMembershipId: world.twin.owner.membershipId,
      }),
    );
    const asNorthstar = await tenant.read(northstar, (tx) =>
      files.findLink(tx, northstar, world.twin.workItemId, twinLink.id),
    );
    expect(asNorthstar).toBeNull();
  });

  it('references an owned file only: a cross-tenant file id is refused (0086 fk)', async () => {
    const itemId = await newItem('Only my own files');
    const twinFile = await insertFileAsset(
      world.twin.organizationId,
      world.twin.projectId,
      world.twin.owner.id,
      'not-mine.pdf',
    );
    // Northstar's credential, naming the twin's file: fk_work_item_files_file_asset has no such pair.
    await expect(
      tenant.transaction(northstar, (tx) =>
        files.create(tx, northstar, {
          workItemId: itemId,
          fileAssetId: twinFile,
          attachedByMembershipId: world.northstar.owner.membershipId,
        }),
      ),
    ).rejects.toThrow(/foreign key constraint fails/i);
  });

  it('cannot attach to a work item in another org (0086 fk)', async () => {
    const fileId = await insertFileAsset(
      world.northstar.organizationId,
      world.northstar.projectId,
      world.northstar.owner.id,
      'mine.pdf',
    );
    await expect(
      tenant.transaction(northstar, (tx) =>
        files.create(tx, northstar, {
          workItemId: world.twin.workItemId,
          fileAssetId: fileId,
          attachedByMembershipId: world.northstar.owner.membershipId,
        }),
      ),
    ).rejects.toThrow(/foreign key constraint fails/i);
  });

  it('attaches a file to a work item at most once (uq_work_item_files_edge)', async () => {
    const itemId = await newItem('Attach once');
    const fileId = await insertFileAsset(
      world.northstar.organizationId,
      world.northstar.projectId,
      world.northstar.owner.id,
      'once.pdf',
    );
    await tenant.transaction(northstar, (tx) =>
      files.create(tx, northstar, {
        workItemId: itemId,
        fileAssetId: fileId,
        attachedByMembershipId: world.northstar.owner.membershipId,
      }),
    );
    await expect(
      tenant.transaction(northstar, (tx) =>
        files.create(tx, northstar, {
          workItemId: itemId,
          fileAssetId: fileId,
          attachedByMembershipId: world.northstar.owner.membershipId,
        }),
      ),
    ).rejects.toThrow(/Duplicate entry/);
  });
});

describe('work intake forms', () => {
  const fieldDefs = [
    { label: 'Summary', type: 'text' as const, required: true },
    { label: 'Budget', type: 'number' as const, required: false },
    { label: 'Needed by', type: 'date' as const, required: false },
  ];

  async function seedForm(context: TenantContext, createdBy: string, name = 'Project intake') {
    return tenant.transaction(context, (tx) =>
      forms.create(tx, context, { name, fields: fieldDefs, createdBy }),
    );
  }

  /** The controller's submit, exactly: resolve the form tenant-scoped, validate, then create. */
  async function submit(
    context: TenantContext,
    principal: Principal,
    formId: string,
    title: string,
    values: unknown,
  ): Promise<WorkItemView> {
    const form = await tenant.read(context, (tx) => forms.findById(tx, context, formId));
    if (!form) {
      throw new ApiError(404, 'not_found', 'not found');
    }
    validateSubmissionValues(form.fieldsJson, values);
    return work.create(context, principal, { projectId: world.northstar.projectId, title });
  }

  it('a form definition round-trips and never crosses a tenant', async () => {
    const form = await seedForm(northstar, world.northstar.owner.id);
    expect(form.organizationId).toBe(world.northstar.organizationId);
    expect(form.fieldsJson).toEqual(fieldDefs);

    const reread = await tenant.read(northstar, (tx) => forms.findById(tx, northstar, form.id));
    expect(reread?.fieldsJson).toEqual(fieldDefs);

    // A twin form, identically shaped, does not resolve for Northstar.
    const twinForm = await seedForm(twin, world.twin.owner.id, 'Project intake');
    const asNorthstar = await tenant.read(northstar, (tx) =>
      forms.findById(tx, northstar, twinForm.id),
    );
    expect(asNorthstar).toBeNull();
    const mine = await tenant.read(northstar, (tx) => forms.list(tx, northstar));
    expect(mine.map((row) => row.id)).not.toContain(twinForm.id);
  });

  it('a valid submission creates exactly one work item', async () => {
    const form = await seedForm(northstar, world.northstar.owner.id, 'Valid intake');
    const before = await observe('select count(*) as n from work_items where organization_id = ?', [
      world.northstar.organizationId,
    ]);
    const created = await submit(northstar, owner, form.id, 'Build the loyalty portal', {
      Summary: 'A points-based loyalty portal',
      Budget: 25000,
      'Needed by': '2026-12-01T00:00:00.000Z',
    });
    expect(created.id).toBeTruthy();
    const after = await observe('select count(*) as n from work_items where organization_id = ?', [
      world.northstar.organizationId,
    ]);
    expect(Number(after[0]?.['n']) - Number(before[0]?.['n'])).toBe(1);
  });

  it('an invalid submission is rejected against the stored schema, and writes no work item', async () => {
    const form = await seedForm(northstar, world.northstar.owner.id, 'Guarded intake');
    const countItems = async (): Promise<number> => {
      const rows = await observe('select count(*) as n from work_items where organization_id = ?', [
        world.northstar.organizationId,
      ]);
      return Number(rows[0]?.['n']);
    };
    const before = await countItems();

    // Missing the required `Summary`.
    await expectApiError(submit(northstar, owner, form.id, 'No summary', { Budget: 10 }), 400);
    // `Budget` is declared a number; a string is rejected.
    await expectApiError(
      submit(northstar, owner, form.id, 'Bad budget', { Summary: 'ok', Budget: 'lots' }),
      400,
    );
    // A field the form does not declare cannot be smuggled in.
    await expectApiError(
      submit(northstar, owner, form.id, 'Undeclared', { Summary: 'ok', Secret: 'x' }),
      400,
    );

    expect(await countItems()).toBe(before);
  });

  it('refuses to re-tenant a form (0052 trigger)', async () => {
    const form = await seedForm(northstar, world.northstar.owner.id, 'Pinned intake');
    await expect(
      db.admin.execute('update work_forms set organization_id = ? where id = ?', [
        world.twin.organizationId,
        form.id,
      ]),
    ).rejects.toThrow(/organization_id is immutable/);
  });
});
