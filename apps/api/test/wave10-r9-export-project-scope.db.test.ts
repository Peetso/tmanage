import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import { TenantDatabase, createServiceContext } from '../src/common/database/tenant-context.js';
import { ArchiveFileContents } from '../src/modules/privacy/privacy-archive-files.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * Audit run 2, NO-GO reason 3 — N03's personal-export SQL (left joins on memberships, projects,
 * project_memberships, client_memberships and project_clients, `max(case …)`, `group by`) run on
 * a real MariaDB 11.8 under the enforcing tenant guard, which the unit test's fake runner never did.
 *
 * Lina (the designer, an ordinary member, no org-wide or workspace scope) added one file to each of
 * two Northstar projects. While she is on both, both files come back readable. Once she is removed
 * from the second project, that file is withheld — `{ included: false, left_out:
 * 'no_project_access' }` with nothing else of it — and her other file is unchanged.
 *
 * Lives in `test/` because only `test/**\/*.db.test.ts` runs in the `database` project.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
});

afterAll(async () => {
  await db?.stop();
});

async function file(projectId: string, name: string): Promise<string> {
  const id = uuidv7();
  await db.admin.execute(
    `insert into file_assets
       (id, organization_id, project_id, owner_user_id, name, purpose, audience, status, version,
        created_at, updated_at)
     values (?, ?, ?, ?, ?, 'deliverable', 'internal', 'pending_upload', 1, ?, ?)`,
    [
      id,
      world.northstar.organizationId,
      projectId,
      world.northstar.designer.id,
      name,
      new Date(),
      new Date(),
    ],
  );
  return id;
}

function reader(): ArchiveFileContents {
  // No version is uploaded, so no bytes are ever opened; the policy is not under test.
  const store = {
    openObject: async () => {
      throw new Error('no object is opened in this suite');
    },
  };
  return new ArchiveFileContents(tenant, store, undefined, async () => 'allow_labeled');
}

const context = () =>
  createServiceContext({
    organizationId: world.northstar.organizationId,
    correlationId: uuidv7(),
    policyVersion: 'privacy-job',
  });

describe('N03 on MariaDB — a personal export withholds the files of a project the person left', () => {
  it('both files readable while she is on both projects; the left project withheld after removal', async () => {
    const designer = world.northstar.designer.id;
    const other = world.northstar.otherProjectId;
    await db.admin.execute(
      `insert into project_memberships (id, organization_id, project_id, user_id)
       values (?, ?, ?, ?)`,
      [uuidv7(), world.northstar.organizationId, other, designer],
    );
    const kept = await file(world.northstar.projectId, 'kept-brief.pdf');
    const left = await file(other, 'left-brief.pdf');

    const before = await reader().read(context(), designer);
    const byId = (rows: typeof before) => new Map(rows.map((row) => [row.file_id, row]));
    const keptBefore = byId(before).get(kept);
    expect(keptBefore).toMatchObject({ file_id: kept, name: 'kept-brief.pdf', included: false });
    expect(byId(before).get(left)).toMatchObject({ file_id: left, name: 'left-brief.pdf' });
    expect(before).toHaveLength(2);

    await db.admin.execute(
      'delete from project_memberships where organization_id = ? and project_id = ? and user_id = ?',
      [world.northstar.organizationId, other, designer],
    );

    const after = await reader().read(context(), designer);
    expect(after).toHaveLength(2);
    // Exactly the withheld shape: no name, size, version or bytes.
    expect(byId(after).get(left)).toEqual({
      file_id: left,
      included: false,
      left_out: 'no_project_access',
    });
    // Her other file is unchanged.
    expect(byId(after).get(kept)).toEqual(keptBefore);
  });

  it("the company export (no subject) is unchanged and still lists the left project's file in full", async () => {
    const rows = await reader().read(context(), null);
    const named = rows.filter((row) => 'name' in row && row.name === 'left-brief.pdf');
    expect(named).toHaveLength(1);
  });
});
