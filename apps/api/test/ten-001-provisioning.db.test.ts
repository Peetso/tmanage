import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { RowDataPacket } from 'mysql2/promise';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { TenantDatabase } from '../src/common/database/tenant-context.js';
import { apiConfigFrom } from '../src/common/http/api-config.js';
import type { ApiConfig } from '../src/common/http/api-config.js';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import type { TenantGuardEvent } from '../src/common/database/tenant-guard.js';
import { AuditEventsRepository } from '../src/modules/audit/audit-events.repository.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { MembershipResolver } from '../src/modules/tenancy/membership-resolver.repository.js';
import { OrganizationDirectoryRepository } from '../src/modules/tenancy/organization-directory.repository.js';
import { ProvisioningService } from '../src/modules/tenancy/provisioning.service.js';
import { OrganizationSlugTakenError } from '../src/modules/tenancy/organizations.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * TEN-001's second half against a real server — provisioning, and the organization directory.
 *
 * Four claims, and the first is the one the whole design rests on:
 *
 * 1. **Provisioning is not a hole in the tenant guard.** It runs inside a `TenantContext`
 *    bound to the organization it is creating, so the guard stays in `enforce` mode
 *    throughout and reports no violation. The gap note this ticket closes claimed the
 *    opposite was necessary.
 * 2. **All of it, or none of it.** An organization with no owner membership is unreachable
 *    and unadministrable forever. A failure part-way must leave nothing behind.
 * 3. **The founder can immediately act.** The proof is not that rows exist — it is that
 *    `MembershipResolver`, the real §3 step 2, resolves the new organization for that person
 *    on the very next call.
 * 4. **The directory lists only your own organizations**, and takes no identifier from the
 *    caller that could be varied to widen it.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;
let tenant: TenantDatabase;
let guardEvents: TenantGuardEvent[];
let provisioning: ProvisioningService;
let directory: OrganizationDirectoryRepository;
let resolver: MembershipResolver;

const SESSION_SECRET = 'local_dev_only_session_secret_for_the_provisioning_suite';
const CSRF_SECRET = 'local_dev_only_csrf_secret_for_the_provisioning_suite_x';

const CONFIG: ApiConfig = apiConfigFrom({
  NODE_ENV: 'test',
  SESSION_COOKIE_NAME: 'tmanage_session',
  SESSION_SECRET,
  SESSION_TTL_SECONDS: 900,
  REFRESH_TTL_SECONDS: 1_209_600,
  CSRF_SECRET,
  API_PUBLIC_URL: 'http://localhost:4000',
  AUTH_MAX_FAILURES_IN_WINDOW: 50,
  AUTH_FAILURE_WINDOW_SECONDS: 900,
  AUTH_TOTP_ISSUER: 'TManage',
  CLIENT_MEMBERSHIP_DEFAULT_EXPIRY_DAYS: 180,
});

interface InjectedResponse {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: Record<string, unknown>;
  json<T = unknown>(): T;
}

function setCookies(response: InjectedResponse): readonly string[] {
  const raw = response.headers['set-cookie'];
  if (Array.isArray(raw)) return raw as string[];
  return typeof raw === 'string' ? [raw] : [];
}

function cookieHeader(cookies: readonly string[]): string {
  return cookies
    .map((c) => c.split(';')[0] ?? '')
    .filter((pair) => pair.split('=').slice(1).join('=').length > 0)
    .join('; ');
}

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

async function signIn(userId: string): Promise<{ cookie: string; csrfToken: string }> {
  const response = (await app.inject({
    method: 'POST',
    url: '/v1/dev/sessions',
    headers: { 'content-type': 'application/json' },
    payload: { userId },
  })) as unknown as InjectedResponse;
  const cookies = setCookies(response);
  return {
    cookie: cookieHeader(cookies),
    csrfToken: response.json<{ csrfToken: string }>().csrfToken,
  };
}

const founder = () => world.northstar.designer;

const NEW_ORG = {
  name: 'Lumen Works',
  slug: 'lumen-works',
  timezone: 'Africa/Cairo',
  defaultLocale: 'en',
};

beforeAll(async () => {
  db = await startTestDatabase();
  guardEvents = [];
  tenant = new TenantDatabase(db.runtime, {
    guardMode: 'enforce',
    onGuardEvent: (event) => guardEvents.push(event),
  });
  const audit = new AuditService(tenant, new AuditEventsRepository());
  provisioning = new ProvisioningService(tenant, audit);
  directory = new OrganizationDirectoryRepository(tenant);
  resolver = new MembershipResolver(tenant);

  app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      config: CONFIG,
      database: DatabaseModule.forPool({ pool: db.runtime, guardMode: 'enforce' }),
    }),
    new FastifyAdapter(),
    { logger: false, abortOnError: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 300_000);

beforeEach(async () => {
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  guardEvents.length = 0;
});

afterAll(async () => {
  await app?.close();
  await db?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('provisioning an organization', () => {
  it('creates the organization, a workspace and an active owner membership', async () => {
    const created = await provisioning.provisionOrganization({
      userId: founder().id,
      correlationId: uuidv7(),
      ...NEW_ORG,
    });

    const organizations = await observe('select * from organizations where id = ?', [
      created.organizationId,
    ]);
    expect(organizations).toHaveLength(1);
    expect(organizations[0]!['slug']).toBe('lumen-works');
    expect(organizations[0]!['timezone']).toBe('Africa/Cairo');

    const workspaces = await observe('select * from workspaces where organization_id = ?', [
      created.organizationId,
    ]);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]!['name']).toBe('Lumen Works');

    const memberships = await observe('select * from memberships where organization_id = ?', [
      created.organizationId,
    ]);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!['user_id']).toBe(founder().id);
    expect(memberships[0]!['role']).toBe('owner');
    // `active`, not `invited`. There is nobody to accept an invitation from.
    expect(memberships[0]!['status']).toBe('active');
    expect(Number(memberships[0]!['has_org_wide_scope'])).toBe(1);
  });

  /**
   * Claim 1. The gap note said provisioning "cannot run under a `TenantContext`". It does,
   * with the guard in `enforce` mode, and the guard has nothing to report.
   */
  it('raises no tenant-guard violation, with the guard enforcing', async () => {
    await provisioning.provisionOrganization({
      userId: founder().id,
      correlationId: uuidv7(),
      ...NEW_ORG,
    });
    expect(guardEvents.flatMap((event) => event.violations)).toEqual([]);
  });

  it('writes the audit row in the same transaction, naming the new organization', async () => {
    const created = await provisioning.provisionOrganization({
      userId: founder().id,
      correlationId: uuidv7(),
      ...NEW_ORG,
    });

    const events = await observe('select * from audit_events where organization_id = ?', [
      created.organizationId,
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!['action']).toBe('organization.provisioned');
    expect(events[0]!['object_type']).toBe('organization');
    expect(events[0]!['object_id']).toBe(created.organizationId);
    expect(events[0]!['actor_user_id']).toBe(founder().id);

    // `mysql2` parses a JSON column into an object already; `JSON.parse(String(...))` would
    // be parsing "[object Object]".
    const raw = events[0]!['metadata_json'];
    const metadata = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
    expect(metadata['slug']).toBe('lumen-works');
    expect(metadata['role']).toBe('owner');
    expect(metadata['workspace_id']).toBeTruthy();
  });

  /**
   * Claim 3. Rows existing is not the proof. The proof is that the real §3 step 2 resolves
   * the new organization for this person on the very next call, with no other change.
   */
  it('leaves the founder able to act in the organization immediately', async () => {
    const created = await provisioning.provisionOrganization({
      userId: founder().id,
      correlationId: uuidv7(),
      ...NEW_ORG,
    });

    const resolved = await resolver.resolve({
      userId: founder().id,
      organization: { slug: 'lumen-works' },
      correlationId: uuidv7(),
    });

    expect(resolved.context.organizationId).toBe(created.organizationId);
    expect(resolved.context.principalKind).toBe('internal');
    expect(resolved.role).toBe('owner');
    expect(resolved.context.membershipId).toBe(created.membershipId);
    expect(resolved.hasOrgWideScope).toBe(true);
    // An owner holds every capability. Asserted against the domain rather than restated.
    expect(resolved.context.capabilities.length).toBe(capabilitiesFor('owner').length);
    // The provisioning context's literal `policyVersion` is gone; a real one has replaced it.
    expect(resolved.context.policyVersion).not.toBe('provisioning');
  });

  /** Claim 2. A taken slug must leave nothing behind — not a workspace, not a membership. */
  it('rolls the whole transaction back when the slug is taken', async () => {
    await provisioning.provisionOrganization({
      userId: founder().id,
      correlationId: uuidv7(),
      ...NEW_ORG,
    });

    const before = await observe('select count(*) as n from memberships');

    await expect(
      provisioning.provisionOrganization({
        userId: world.northstar.manager.id,
        correlationId: uuidv7(),
        ...NEW_ORG,
        name: 'A different name, the same address',
      }),
    ).rejects.toBeInstanceOf(OrganizationSlugTakenError);

    const after = await observe('select count(*) as n from memberships');
    expect(Number(after[0]!['n'])).toBe(Number(before[0]!['n']));

    // Exactly one organization holds the slug, and it is the first one.
    const organizations = await observe('select name from organizations where slug = ?', [
      'lumen-works',
    ]);
    expect(organizations).toHaveLength(1);
    expect(organizations[0]!['name']).toBe('Lumen Works');
  });

  it('lets one person found two organizations', async () => {
    const first = await provisioning.provisionOrganization({
      userId: founder().id,
      correlationId: uuidv7(),
      ...NEW_ORG,
    });
    const second = await provisioning.provisionOrganization({
      userId: founder().id,
      correlationId: uuidv7(),
      ...NEW_ORG,
      slug: 'lumen-works-two',
      name: 'Lumen Works Two',
    });

    expect(first.organizationId).not.toBe(second.organizationId);
    const rows = await observe('select organization_id from memberships where user_id = ?', [
      founder().id,
    ]);
    // The seeded Northstar membership, plus the two founded here.
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  it('touches no other tenant', async () => {
    const before = await observe(
      'select id, name, slug, updated_at from organizations where id = ?',
      [world.northstar.organizationId],
    );

    await provisioning.provisionOrganization({
      userId: founder().id,
      correlationId: uuidv7(),
      ...NEW_ORG,
    });

    const after = await observe(
      'select id, name, slug, updated_at from organizations where id = ?',
      [world.northstar.organizationId],
    );
    expect(after).toEqual(before);
  });
});

describe('the organization directory', () => {
  it('lists an internal membership', async () => {
    const rows = await directory.listForUser({
      userId: founder().id,
      correlationId: uuidv7(),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.organizationId).toBe(world.northstar.organizationId);
    expect(rows[0]!.audience).toBe('internal');
    expect(rows[0]!.clientOrganizationName).toBeNull();
  });

  it('lists a client membership with the client organization’s own name', async () => {
    const rows = await directory.listForUser({
      userId: world.atlas.reviewer.id,
      correlationId: uuidv7(),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.audience).toBe('client');
    expect(rows[0]!.clientOrganizationName).not.toBeNull();
  });

  /**
   * Claim 4. The one input is the session's own user id, so there is nothing to vary. This
   * asserts the consequence: one person's list never contains another's organization.
   */
  it('never returns an organization the person does not belong to', async () => {
    const created = await provisioning.provisionOrganization({
      userId: founder().id,
      correlationId: uuidv7(),
      ...NEW_ORG,
    });

    const stranger = await directory.listForUser({
      userId: world.brightops.owner.id,
      correlationId: uuidv7(),
    });

    expect(stranger.map((row) => row.organizationId)).not.toContain(created.organizationId);
    expect(stranger.every((row) => row.organizationId === world.brightops.organizationId)).toBe(
      true,
    );
  });

  it('returns an empty list rather than failing for a person who belongs to nothing', async () => {
    const [nobody] = await observe(
      `select u.id from users u
        left join memberships m on m.user_id = u.id
        left join client_memberships cm on cm.user_id = u.id
        where m.id is null and cm.id is null limit 1`,
    );

    // The seeded world may give everyone a membership; if so, make one.
    const userId = nobody ? String(nobody['id']) : uuidv7();
    if (!nobody) {
      await db.admin.query(
        'insert into users (id, email, display_name, email_verified_at) values (?, ?, ?, now(3))',
        [userId, `nobody-${userId}@example.test`, 'Nobody'],
      );
    }

    const rows = await directory.listForUser({ userId, correlationId: uuidv7() });
    expect(rows).toEqual([]);
  });

  it('excludes an archived organization', async () => {
    const created = await provisioning.provisionOrganization({
      userId: founder().id,
      correlationId: uuidv7(),
      ...NEW_ORG,
    });
    await db.admin.query('update organizations set archived_at = now(3) where id = ?', [
      created.organizationId,
    ]);

    const rows = await directory.listForUser({
      userId: founder().id,
      correlationId: uuidv7(),
    });
    expect(rows.map((row) => row.organizationId)).not.toContain(created.organizationId);
  });

  it('excludes an expired client membership', async () => {
    await db.admin.query(
      'update client_memberships set expires_at = date_sub(now(3), interval 1 day) where user_id = ?',
      [world.atlas.reviewer.id],
    );

    const rows = await directory.listForUser({
      userId: world.atlas.reviewer.id,
      correlationId: uuidv7(),
    });
    expect(rows).toEqual([]);
  });
});

describe('over HTTP', () => {
  it('creates an organization for a signed-in person', async () => {
    const session = await signIn(founder().id);

    const response = (await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: {
        'content-type': 'application/json',
        cookie: session.cookie,
        [CSRF_HEADER]: session.csrfToken,
      },
      payload: NEW_ORG,
    })) as unknown as InjectedResponse;

    expect(response.statusCode).toBe(201);
    const body = response.json<{ id: string; slug: string; role: string; workspaceId: string }>();
    expect(body.slug).toBe('lumen-works');
    expect(body.role).toBe('owner');
    expect(body.workspaceId).toBeTruthy();
  });

  it('refuses an unauthenticated caller', async () => {
    const response = (await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { 'content-type': 'application/json' },
      payload: NEW_ORG,
    })) as unknown as InjectedResponse;
    expect(response.statusCode).toBe(401);
  });

  it('refuses a session with no CSRF token', async () => {
    const session = await signIn(founder().id);
    const response = (await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { 'content-type': 'application/json', cookie: session.cookie },
      payload: NEW_ORG,
    })) as unknown as InjectedResponse;
    expect(response.statusCode).toBe(403);
  });

  it.each([
    ['a missing name', { ...NEW_ORG, name: '' }, 'name'],
    ['an uppercase slug', { ...NEW_ORG, slug: 'Lumen-Works' }, 'slug'],
    ['an underscore in the slug', { ...NEW_ORG, slug: 'lumen_works' }, 'slug'],
    ['a leading hyphen', { ...NEW_ORG, slug: '-lumen' }, 'slug'],
    ['a reserved slug', { ...NEW_ORG, slug: 'admin' }, 'slug'],
    ['an unknown timezone', { ...NEW_ORG, timezone: 'Mars/Olympus' }, 'timezone'],
  ])('refuses %s, naming the field', async (_name, payload, field) => {
    const session = await signIn(founder().id);
    const response = (await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: {
        'content-type': 'application/json',
        cookie: session.cookie,
        [CSRF_HEADER]: session.csrfToken,
      },
      payload,
    })) as unknown as InjectedResponse;

    expect(response.statusCode).toBe(422);
    const body = response.json<{ error: { details: { field: string }[] } }>();
    expect(body.error.details.map((detail) => detail.field)).toContain(field);
  });

  /**
   * The one place in the identity surface that says something specific about a specific
   * identifier. Safe because the caller is authenticated and the fact is public anyway —
   * anyone can visit the URL — and necessary because a person cannot choose another address
   * without being told this one is gone.
   */
  it('answers 409 for a slug that is taken, and names the field', async () => {
    const session = await signIn(founder().id);
    const create = async () =>
      (await app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: {
          'content-type': 'application/json',
          cookie: session.cookie,
          [CSRF_HEADER]: session.csrfToken,
        },
        payload: NEW_ORG,
      })) as unknown as InjectedResponse;

    expect((await create()).statusCode).toBe(201);
    const second = await create();
    expect(second.statusCode).toBe(409);
    const body = second.json<{ error: { code: string; details: { field: string }[] } }>();
    expect(body.error.code).toBe('conflict');
    expect(body.error.details[0]!.field).toBe('slug');
  });

  it('lists the caller’s organizations, and nobody else’s', async () => {
    const session = await signIn(founder().id);
    const response = (await app.inject({
      method: 'GET',
      url: '/v1/organizations',
      headers: { cookie: session.cookie },
    })) as unknown as InjectedResponse;

    expect(response.statusCode).toBe(200);
    const body = response.json<{ organizations: { id: string; slug: string }[] }>();
    expect(body.organizations).toHaveLength(1);
    expect(body.organizations[0]!.id).toBe(world.northstar.organizationId);
    expect(response.body).not.toContain(world.brightops.organizationId);
  });

  it('answers 200 with an empty list rather than 404 for a person with no memberships', async () => {
    const userId = uuidv7();
    await db.admin.query(
      'insert into users (id, email, display_name, email_verified_at) values (?, ?, ?, now(3))',
      [userId, `fresh-${userId}@example.test`, 'Fresh Account'],
    );
    const session = await signIn(userId);

    const response = (await app.inject({
      method: 'GET',
      url: '/v1/organizations',
      headers: { cookie: session.cookie },
    })) as unknown as InjectedResponse;

    expect(response.statusCode).toBe(200);
    expect(response.json<{ organizations: unknown[] }>().organizations).toEqual([]);
  });

  /**
   * The end-to-end claim, and the first time this system has been able to make it: a person
   * signs in, creates an organization, and it is theirs on the next request.
   */
  it('signs in, creates, and lists what was created', async () => {
    const userId = uuidv7();
    await db.admin.query(
      'insert into users (id, email, display_name, email_verified_at) values (?, ?, ?, now(3))',
      [userId, `founder-${userId}@example.test`, 'A Founder'],
    );
    const session = await signIn(userId);

    const created = (await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: {
        'content-type': 'application/json',
        cookie: session.cookie,
        [CSRF_HEADER]: session.csrfToken,
      },
      payload: NEW_ORG,
    })) as unknown as InjectedResponse;
    expect(created.statusCode).toBe(201);

    const listed = (await app.inject({
      method: 'GET',
      url: '/v1/organizations',
      headers: { cookie: session.cookie },
    })) as unknown as InjectedResponse;

    const body = listed.json<{ organizations: { slug: string; role: string }[] }>();
    expect(body.organizations).toHaveLength(1);
    expect(body.organizations[0]!.slug).toBe('lumen-works');
    expect(body.organizations[0]!.role).toBe('owner');
  });
});
