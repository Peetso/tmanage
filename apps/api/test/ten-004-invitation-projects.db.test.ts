import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { parseGrantScript } from '../src/common/database/grants.js';
import { TABLES } from '../src/common/database/schema.js';
import { TENANT_TABLES } from '../src/common/database/tenant-guard.js';
import { usingLeastPrivilegeCredential } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import type { SeedWorld } from './seed-two-tenants.js';
import {
  bootHttpHarness,
  reseed,
  signIn as harnessSignIn,
  stopHarness,
} from './support/http-harness.js';
import type { InjectedResponse, Session } from './support/http-harness.js';

/**
 * TEN-004 over real HTTP — A1 (migration 0218): "Add to projects" and "Personal note" on an
 * invitation.
 *
 * 1. **Nothing is granted at issue.** The projects wait in `invitation_projects`; the person is
 *    put on them only when they accept.
 * 2. **Tenant isolation.** A project of another tenant is a 400 with nothing written, and the
 *    composite foreign keys refuse a cross-tenant pair even from a credential that skips the
 *    service.
 * 3. **The rows are write-once.** The trigger pins every identity column, and `users.sql` gives
 *    the runtime credential INSERT only.
 * 4. **The note is the invitee's to read, never the audit trail's.**
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const HERE = dirname(fileURLToPath(import.meta.url));
const intents = parseGrantScript(
  readFileSync(resolve(HERE, '../../../scripts/db/users.sql'), 'utf8'),
);

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

function signIn(userId: string): Promise<Session> {
  return harnessSignIn(app, userId);
}

const NORTHSTAR = 'northstar-studio';

async function send(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  session: Session,
  payload?: unknown,
): Promise<InjectedResponse> {
  return (await app.inject({
    method,
    url,
    headers: {
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      cookie: session.cookie,
      ...(method === 'GET' ? {} : { [CSRF_HEADER]: session.csrfToken }),
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  })) as unknown as InjectedResponse;
}

const orgUrl = (path: string, slug = NORTHSTAR): string => `/v1/organizations/${slug}${path}`;

interface Issued {
  invitation: { id: string; status: string };
  token: string;
}

async function issue(session: Session, body: Record<string, unknown>): Promise<InjectedResponse> {
  return send('POST', orgUrl('/invitations'), session, {
    email: 'nadia.fahmy@example.test',
    role: 'member',
    ...body,
  });
}

async function projectRowsOf(invitationId: string): Promise<string[]> {
  const rows = await observe(
    'select project_id from invitation_projects where invitation_id = ? order by project_id',
    [invitationId],
  );
  return rows.map((row) => String(row['project_id']));
}

async function projectMembershipsOf(userId: string, organizationId: string): Promise<string[]> {
  const rows = await observe(
    `select project_id from project_memberships
      where organization_id = ? and user_id = ? order by project_id`,
    [organizationId, userId],
  );
  return rows.map((row) => String(row['project_id']));
}

const owner = () => world.northstar.owner;
/** Somebody with an account and no membership in Northstar. */
const outsider = () => world.brightops.owner;

beforeAll(async () => {
  ({ app, db } = await bootHttpHarness({ secretTag: 'the_ten_004_suite', guardMode: 'enforce' }));
}, 300_000);

beforeEach(async () => {
  world = await reseed(db);
});

afterAll(async () => {
  await stopHarness({ app, db });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('registry — invitation_projects is a tenant table in all four places', () => {
  it('is in TABLES and TENANT_TABLES, and users.sql grants the runtime INSERT only', () => {
    expect(Object.keys(TABLES)).toContain('invitation_projects');
    expect(TENANT_TABLES['invitation_projects']).toBe('organization_id');

    const appIntent = intents.get(`'tmanage_app'@'%'`);
    const worker = intents.get(`'tmanage_worker'@'%'`);
    const onTable = (privileges: ReadonlySet<string> | undefined) =>
      [...(privileges ?? [])].filter((key) => key.startsWith('tmanage.invitation_projects:'));
    // Written once at issue; never updated or deleted. SELECT comes from the database-wide read.
    expect(onTable(appIntent?.privileges)).toEqual(['tmanage.invitation_projects:INSERT']);
    expect(appIntent?.privileges.has('tmanage.*:SELECT')).toBe(true);
    // The worker's invitation sweep never touches the projects an invitation carries.
    expect(onTable(worker?.privileges)).toEqual([]);
  });

  it.skipIf(!usingLeastPrivilegeCredential)(
    'holds no UPDATE or DELETE for the runtime credential to reach for',
    async () => {
      const grants = await observe("show grants for 'tmanage_app'@'%'");
      const line = grants
        .map((row) => String(Object.values(row)[0]))
        .find((text) => text.includes('`invitation_projects`'));
      expect(line, 'no grant names invitation_projects').toBeDefined();
      expect(line).not.toMatch(/UPDATE|DELETE/i);
    },
  );
});

describe('issuing with projects and a note', () => {
  it('stores the projects and the note, and grants no project membership yet', async () => {
    const session = await signIn(owner().id);
    const response = await issue(session, {
      projectIds: [world.northstar.projectId, world.northstar.otherProjectId],
      note: '  Welcome aboard — see you Monday.  ',
    });
    expect(response.statusCode).toBe(201);
    const { invitation } = response.json<Issued>();

    expect(await projectRowsOf(invitation.id)).toEqual(
      [world.northstar.projectId, world.northstar.otherProjectId].sort(),
    );
    const [row] = await observe('select note from invitations where id = ?', [invitation.id]);
    expect(row?.['note']).toBe('Welcome aboard — see you Monday.');
    expect(await projectMembershipsOf(outsider().id, world.northstar.organizationId)).toEqual([]);

    // The issue is audited with a count of projects and never the note's words.
    const audits = await observe(
      `select metadata_json from audit_events
        where organization_id = ? and action = 'invitation.issued' and object_id = ?`,
      [world.northstar.organizationId, invitation.id],
    );
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!['metadata_json'])).not.toContain('Welcome aboard');
  });

  it('puts the person on those projects when they accept', async () => {
    const inviter = await signIn(owner().id);
    const issued = await issue(inviter, { projectIds: [world.northstar.otherProjectId] });
    expect(issued.statusCode).toBe(201);
    const { token } = issued.json<Issued>();

    const invitee = await signIn(outsider().id);
    const accepted = await send('POST', '/v1/invitations/acceptances', invitee, { token });
    expect(accepted.statusCode).toBe(201);

    expect(await projectMembershipsOf(outsider().id, world.northstar.organizationId)).toEqual([
      world.northstar.otherProjectId,
    ]);
  });

  it('refuses projects on a client invitation, and writes nothing', async () => {
    const session = await signIn(owner().id);
    const response = await issue(session, {
      role: 'client_viewer',
      clientOrganizationId: world.atlas.clientOrganizationId,
      projectIds: [world.northstar.projectId],
    });
    expect(response.statusCode).toBe(400);
    expect(await observe('select id from invitation_projects')).toHaveLength(0);
  });

  it('refuses a note longer than the column', async () => {
    const session = await signIn(owner().id);
    const response = await issue(session, { note: 'x'.repeat(501) });
    expect(response.statusCode).toBe(400);
    expect(await observe('select id from invitations')).toHaveLength(0);
  });
});

describe('tenant isolation', () => {
  it('refuses the adversarial twin’s project as a 400 and writes no invitation', async () => {
    const session = await signIn(owner().id);
    const response = await issue(session, {
      projectIds: [world.northstar.projectId, world.twin.projectId],
    });
    expect(response.statusCode).toBe(400);
    expect(await observe('select id from invitation_projects')).toHaveLength(0);
    expect(
      await observe('select id from invitations where organization_id = ?', [
        world.northstar.organizationId,
      ]),
    ).toHaveLength(0);
  });

  it('refuses a cross-tenant pair at the storage layer, whatever the service does', async () => {
    const session = await signIn(owner().id);
    const response = await issue(session, { projectIds: [world.northstar.projectId] });
    const { invitation } = response.json<Issued>();

    // Northstar's invitation with the twin's project: no (organization_id, project_id) parent.
    await expect(
      db.admin.execute(
        `insert into invitation_projects (id, organization_id, invitation_id, project_id)
         values (?, ?, ?, ?)`,
        [uuidv7(), world.northstar.organizationId, invitation.id, world.twin.projectId],
      ),
    ).rejects.toThrow(/foreign key/i);
    // The twin's organization naming Northstar's invitation: no (organization_id, invitation_id).
    await expect(
      db.admin.execute(
        `insert into invitation_projects (id, organization_id, invitation_id, project_id)
         values (?, ?, ?, ?)`,
        [uuidv7(), world.twin.organizationId, invitation.id, world.twin.projectId],
      ),
    ).rejects.toThrow(/foreign key/i);
    expect(await projectRowsOf(invitation.id)).toEqual([world.northstar.projectId]);
  });

  it('never lists Northstar’s invitation rows to the twin', async () => {
    const session = await signIn(owner().id);
    await issue(session, { projectIds: [world.northstar.projectId], note: 'Northstar only' });

    const twin = await signIn(world.twin.owner.id);
    const listed = await send('GET', orgUrl('/invitations', 'northstar-studios'), twin);
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain('Northstar only');
    expect(listed.body).not.toContain('nadia.fahmy@example.test');
  });
});

describe('write-once rows', () => {
  it('refuses any change to an identity column, even from the admin credential', async () => {
    const session = await signIn(owner().id);
    const response = await issue(session, { projectIds: [world.northstar.projectId] });
    const { invitation } = response.json<Issued>();

    await expect(
      db.admin.execute('update invitation_projects set project_id = ? where invitation_id = ?', [
        world.northstar.otherProjectId,
        invitation.id,
      ]),
    ).rejects.toThrow(/immutable/i);
    expect(await projectRowsOf(invitation.id)).toEqual([world.northstar.projectId]);
  });

  it('collides on a repeated project rather than doubling the row', async () => {
    const session = await signIn(owner().id);
    const response = await issue(session, {
      projectIds: [world.northstar.projectId, world.northstar.projectId],
    });
    // The service de-duplicates the list; the unique key is the backstop.
    expect(response.statusCode).toBe(201);
    const { invitation } = response.json<Issued>();
    expect(await projectRowsOf(invitation.id)).toEqual([world.northstar.projectId]);
    await expect(
      db.admin.execute(
        `insert into invitation_projects (id, organization_id, invitation_id, project_id)
         values (?, ?, ?, ?)`,
        [uuidv7(), world.northstar.organizationId, invitation.id, world.northstar.projectId],
      ),
    ).rejects.toThrow(/duplicate/i);
  });
});
