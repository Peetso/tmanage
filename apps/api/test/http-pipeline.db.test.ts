import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { isUuid, uuidv7 } from '@tmanage/domain';
import type { RowDataPacket } from 'mysql2/promise';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { apiConfigFrom } from '../src/common/http/api-config.js';
import type { ApiConfig } from '../src/common/http/api-config.js';
import type { TenantGuardEvent } from '../src/common/database/tenant-guard.js';
import { mintCsrfToken } from '../src/common/http/csrf.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * The request pipeline, end to end — `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §3.
 *
 * Every other suite here tests one component of the sequence in isolation. This one is the
 * reason those components add up to something: it boots the **real** Nest application over the
 * **real** embedded MySQL with the seeded two-tenant world, and drives genuine HTTP requests
 * through Fastify's injection interface.
 *
 * Three things are proved, and only the first is about happy paths:
 *
 * 1. The five steps run **in order** for a real request. A guard that ran too early, or was
 *    skipped by a decorator, would show up here and nowhere else.
 * 2. **A refusal reveals nothing.** The ordering in §3 exists so that a caller cannot use
 *    error codes to enumerate tenants, projects or memberships. Several cases below compare
 *    two responses byte for byte rather than merely checking both are 4xx — a status-only
 *    assertion would pass while the body gave the game away.
 * 3. **The tenant guard stays on the path.** The membership resolver waives ADR-0001 layer 3
 *    to establish which tenant a session belongs to. `guardEvents` is asserted to contain no
 *    violation across a whole authenticated request, which is what makes that waiver one read
 *    rather than a mode the request stays in.
 *
 * `app.inject()` rather than a listening socket: it exercises the entire Fastify lifecycle —
 * routing, hooks, guards, interceptors, the exception filter, serialisation — without binding
 * a port, so the suite cannot flake on one being in use and cannot be reached from outside.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;
let guardEvents: TenantGuardEvent[];

const SESSION_SECRET = 'local_dev_only_session_secret_for_the_http_suite_xx';
const CSRF_SECRET = 'local_dev_only_csrf_secret_for_the_http_suite_xxxxx';

const CONFIG: ApiConfig = apiConfigFrom({
  NODE_ENV: 'test',
  SESSION_COOKIE_NAME: 'tmanage_session',
  SESSION_SECRET,
  SESSION_TTL_SECONDS: 900,
  REFRESH_TTL_SECONDS: 1_209_600,
  CSRF_SECRET,
  // Plain http, so `secureCookies` resolves false — this suite is not over TLS.
  // `packages/config` refuses a non-https public URL in production, so this cannot become the
  // production shape by accident.
  API_PUBLIC_URL: 'http://localhost:4000',
  // ID-002's lockout window. Deliberately generous here: this suite is about the four-guard
  // pipeline, and a case that signed in a few times in a row must not trip a limiter it is
  // not testing. The window itself is covered by `id-002-credentials.db.test.ts`.
  AUTH_MAX_FAILURES_IN_WINDOW: 50,
  AUTH_FAILURE_WINDOW_SECONDS: 900,
  AUTH_TOTP_ISSUER: 'TManage',
});

interface InjectedResponse {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: Record<string, unknown>;
  json<T = unknown>(): T;
}

/** A signed-in browser: the cookies it would send back, plus the token it would echo. */
interface SignedIn {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly sessionId: string;
  readonly refreshToken: string;
}

function setCookies(response: InjectedResponse): readonly string[] {
  const raw = response.headers['set-cookie'];
  if (Array.isArray(raw)) return raw as string[];
  return typeof raw === 'string' ? [raw] : [];
}

/** Collapse a `Set-Cookie` list into the `Cookie` header a browser would send back. */
function cookieHeader(cookies: readonly string[]): string {
  return cookies
    .map((c) => c.split(';')[0] ?? '')
    .filter((pair) => pair.split('=').slice(1).join('=').length > 0)
    .join('; ');
}

function cookieValue(cookies: readonly string[], name: string): string | undefined {
  for (const cookie of cookies) {
    const pair = cookie.split(';')[0];
    if (!pair) continue;
    const index = pair.indexOf('=');
    if (pair.slice(0, index) === name) return pair.slice(index + 1);
  }
  return undefined;
}

/** Bodies differ only in the correlation id, which is per-request by construction. */
function withoutCorrelationId(response: InjectedResponse): string {
  return response.body.replace(/"correlationId":"[^"]+"/, '"correlationId":"<id>"');
}

/**
 * Sign in through the development-only route.
 *
 * ID-002 is not written, so nothing in this application authenticates a person yet. That is
 * why the route exists and why it is named as it is — see the gap recorded in
 * `docs/implementation-status.md`. What matters for this suite is that everything *after* the
 * session is established is the real pipeline.
 */
async function signIn(userId: string): Promise<SignedIn> {
  const response = (await app.inject({
    method: 'POST',
    url: '/v1/dev/sessions',
    payload: { userId },
  })) as unknown as InjectedResponse;
  expect(response.statusCode).toBe(201);

  const cookies = setCookies(response);
  const body = response.json<{ csrfToken: string }>();
  const accessToken = cookieValue(cookies, 'tmanage_session');
  const refreshToken = cookieValue(cookies, 'tmanage_session_refresh');
  expect(accessToken).toBeDefined();
  expect(refreshToken).toBeDefined();

  return {
    cookie: cookieHeader(cookies),
    csrfToken: body.csrfToken,
    // The access token is `v1.<sessionId>.<exp>.<sig>`, so the id is readable without a lookup.
    sessionId: (accessToken as string).split('.')[1] as string,
    refreshToken: refreshToken as string,
  };
}

function get(
  url: string,
  session?: SignedIn,
  extraHeaders: Record<string, string> = {},
): Promise<InjectedResponse> {
  return app.inject({
    method: 'GET',
    url,
    headers: { ...(session ? { cookie: session.cookie } : {}), ...extraHeaders },
  }) as unknown as Promise<InjectedResponse>;
}

function post(
  url: string,
  session: SignedIn | undefined,
  payload: Record<string, unknown>,
  options: { readonly csrf?: string | null } = {},
): Promise<InjectedResponse> {
  const csrf = options.csrf === undefined ? session?.csrfToken : options.csrf;
  return app.inject({
    method: 'POST',
    url,
    payload,
    headers: {
      ...(session ? { cookie: session.cookie } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
    },
  }) as unknown as Promise<InjectedResponse>;
}

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

beforeAll(async () => {
  db = await startTestDatabase();
  guardEvents = [];

  app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      config: CONFIG,
      database: DatabaseModule.forPool({
        pool: db.runtime,
        guardMode: 'enforce',
        onGuardEvent: (event) => guardEvents.push(event),
      }),
    }),
    new FastifyAdapter(),
    // `abortOnError: false` matters here: Nest's default is to log and call `process.abort()`,
    // which kills the vitest worker before the message reaches the reporter — the failure then
    // presents as `ERR_IPC_CHANNEL_CLOSED` with no cause. A test wants the exception.
    { logger: false, abortOnError: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 300_000);

afterAll(async () => {
  await app?.close();
  await db?.stop();
});

beforeEach(async () => {
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  guardEvents.length = 0;
});

// ─────────────────────────────────────────────────────────────────────────────

describe('step 1 — authentication', () => {
  it('refuses a request with no cookie', async () => {
    const response = await get('/v1/organizations/northstar-studio/projects');
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: 'unauthenticated', message: 'The request carries no valid session' },
    });
  });

  it('refuses a tampered access token', async () => {
    const session = await signIn(world.northstar.owner.id);
    const tampered = session.cookie.replace('tmanage_session=v1.', 'tmanage_session=v1.0');

    const response = (await app.inject({
      method: 'GET',
      url: '/v1/organizations/northstar-studio/projects',
      headers: { cookie: tampered },
    })) as unknown as InjectedResponse;
    expect(response.statusCode).toBe(401);
  });

  it('gives every authentication failure the same body', async () => {
    const noCookie = await get('/v1/organizations/northstar-studio/projects');

    const session = await signIn(world.northstar.owner.id);
    await db.admin.query('UPDATE sessions SET revoked_at = now(3) WHERE id = ?', [
      session.sessionId,
    ]);
    const revoked = await get('/v1/organizations/northstar-studio/projects', session);

    expect(revoked.statusCode).toBe(noCookie.statusCode);
    expect(withoutCorrelationId(revoked)).toBe(withoutCorrelationId(noCookie));
  });

  it('revokes immediately, not at access-token expiry', async () => {
    const session = await signIn(world.northstar.owner.id);
    expect((await get('/v1/organizations/northstar-studio/projects', session)).statusCode).toBe(
      200,
    );

    // The access token is still perfectly valid and unexpired. `authenticate()` reads the
    // session row on every request precisely so that "immediate revocation" (04 §3) means
    // immediate rather than "within SESSION_TTL_SECONDS".
    await db.admin.query('UPDATE sessions SET revoked_at = now(3) WHERE id = ?', [
      session.sessionId,
    ]);

    expect((await get('/v1/organizations/northstar-studio/projects', session)).statusCode).toBe(
      401,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('steps 2 and 3 — the organization is a claim, not a fact', () => {
  it('serves the organization the caller is a member of', async () => {
    const session = await signIn(world.northstar.owner.id);
    const response = await get('/v1/organizations/northstar-studio/projects', session);

    expect(response.statusCode).toBe(200);
    const { projects } = response.json<{ projects: readonly { name: string; id: string }[] }>();
    expect(projects.map((p) => p.id)).toContain(world.northstar.projectId);
  });

  it('refuses an organization the caller has no membership in', async () => {
    const session = await signIn(world.northstar.owner.id);
    const response = await get('/v1/organizations/brightops-consulting/projects', session);
    expect(response.statusCode).toBe(404);
  });

  it('answers identically for a real-but-unreachable slug and one that does not exist', async () => {
    const session = await signIn(world.northstar.owner.id);

    const real = await get('/v1/organizations/brightops-consulting/projects', session);
    const imaginary = await get('/v1/organizations/no-such-company-at-all/projects', session);

    // The control, not a nicety. Slugs are company names, so a caller who can distinguish
    // these two can enumerate the customer base one guess at a time — and any valid session
    // reaches this code path.
    expect(real.statusCode).toBe(404);
    expect(imaginary.statusCode).toBe(404);
    expect(withoutCorrelationId(real)).toBe(withoutCorrelationId(imaginary));
  });

  it('never returns the adversarial twin rows', async () => {
    // Northstar Studio and Northstar Studios: adjacent ids, one letter apart, and both own a
    // project called "Atlas Website Relaunch". A lost tenant predicate returns both.
    const session = await signIn(world.northstar.owner.id);
    const response = await get('/v1/organizations/northstar-studio/projects', session);

    const ids = response.json<{ projects: readonly { id: string }[] }>().projects.map((p) => p.id);
    expect(ids).toContain(world.northstar.projectId);
    expect(ids).not.toContain(world.twin.projectId);

    // And the twin's project really does exist under the same name, so the assertion above is
    // not passing merely because there was nothing to leak.
    const rows = await observe('select id, name from projects where id = ?', [
      world.twin.projectId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['name']).toBe(world.northstar.projectName);
  });

  it('ignores a caller-supplied organization header', async () => {
    const session = await signIn(world.northstar.owner.id);

    // §2: the tenant comes from the membership row the API resolved, and from nothing the
    // caller sent. Headers are the classic place that rule is lost — a "tenant id" header
    // added for a proxy, a job runner, or a debugging convenience, then read one line too
    // early. There is no such header in this application, and this case is what keeps it that
    // way: it sends every plausible spelling, naming another tenant the caller genuinely
    // cannot reach, and asserts the response is unchanged.
    const headers = {
      'x-organization-id': world.brightops.organizationId,
      'x-org-id': world.brightops.organizationId,
      'x-tenant-id': world.brightops.organizationId,
      'x-organization-slug': 'brightops-consulting',
    };

    const withHeaders = await get('/v1/organizations/northstar-studio/projects', session, headers);
    const without = await get('/v1/organizations/northstar-studio/projects', session);

    expect(withHeaders.statusCode).toBe(200);
    const ids = withHeaders
      .json<{ projects: readonly { id: string }[] }>()
      .projects.map((p) => p.id);
    expect(ids).toContain(world.northstar.projectId);
    expect(ids).not.toContain(world.brightops.projectId);

    // Byte-identical, not merely both-200: a header that shifted the tenant would most likely
    // show up as a different row set rather than a different status.
    expect(withHeaders.body).toBe(without.body);
  });

  it('refuses a suspended internal membership', async () => {
    const session = await signIn(world.northstar.designer.id);
    expect((await get('/v1/organizations/northstar-studio/projects', session)).statusCode).toBe(
      200,
    );

    await db.admin.query('UPDATE memberships SET status = ? WHERE id = ?', [
      'suspended',
      world.northstar.designer.membershipId,
    ]);

    expect((await get('/v1/organizations/northstar-studio/projects', session)).statusCode).toBe(
      404,
    );
  });

  it('refuses an expired client membership', async () => {
    const session = await signIn(world.atlas.reviewer.id);

    // 403, not 200, and the distinction is the point of this case. While the client membership
    // is live it *resolves*, so step 3 admits the request and the refusal comes from step 5:
    // `12-PERMISSION-MATRIX` gives Client Reviewer "View internal project: Never", so
    // `work.read` is outside that role's ceiling and this internal endpoint is closed to it.
    // Reaching the capability guard at all is the evidence that the membership resolved.
    expect((await get('/v1/organizations/northstar-studio/projects', session)).statusCode).toBe(
      403,
    );

    await db.admin.query(
      'UPDATE client_memberships SET expires_at = date_sub(now(3), interval 1 day) WHERE id = ?',
      [world.atlas.reviewer.membershipId],
    );

    // Now the membership no longer resolves, so the refusal moves one step earlier and changes
    // shape: 404 from `TenantContextGuard`, indistinguishable from an organization that does
    // not exist. The 403 → 404 transition is what proves expiry is enforced at step 3 rather
    // than being masked by the capability denial that follows it.
    expect((await get('/v1/organizations/northstar-studio/projects', session)).statusCode).toBe(
      404,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('steps 4 and 5 — principal and capability', () => {
  it('scopes an internal member to the projects they belong to', async () => {
    const session = await signIn(world.northstar.designer.id);
    const ids = (await get('/v1/organizations/northstar-studio/projects', session))
      .json<{ projects: readonly { id: string }[] }>()
      .projects.map((p) => p.id);

    expect(ids).toContain(world.northstar.projectId);
    // The designer is deliberately not a member of this one.
    expect(ids).not.toContain(world.northstar.otherProjectId);
  });

  it('gives an organization-wide role the whole tenant', async () => {
    const session = await signIn(world.northstar.owner.id);
    const ids = (await get('/v1/organizations/northstar-studio/projects', session))
      .json<{ projects: readonly { id: string }[] }>()
      .projects.map((p) => p.id);

    expect(ids).toContain(world.northstar.projectId);
    expect(ids).toContain(world.northstar.otherProjectId);
  });

  it('closes the internal projects endpoint to a client principal entirely', async () => {
    const session = await signIn(world.atlas.reviewer.id);
    const response = await get('/v1/organizations/northstar-studio/projects', session);

    // This endpoint is the *internal* project list. `12-PERMISSION-MATRIX` §2 gives every
    // client role "View internal project: Never", so the correct answer is a refusal, not a
    // filtered list — the strongest possible form of the scoping rule, since nothing is
    // returned to be scoped. `work.read` is simply not in the Client Reviewer ceiling and
    // `CapabilityGuard` stops the request before any repository runs.
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'forbidden' } });

    // The complementary assertion — that a client sees their *own* client organization's work
    // and not a sibling client's (Meridian is a different client of the same studio, the
    // boundary `04-SECURITY-PRIVACY` §5 is most emphatic about) — belongs on a Client Portal
    // endpoint, which serves the client projection rather than the internal record. No such
    // endpoint exists yet; it arrives with CLIENT-001, and this case must not be satisfied by
    // granting a client role a capability the matrix withholds.
    expect(response.body).not.toContain(world.meridian.projectId);
  });

  it('refuses a client reviewer the capability to create a project', async () => {
    const session = await signIn(world.atlas.reviewer.id);
    const response = await post('/v1/organizations/northstar-studio/projects', session, {
      workspaceId: world.northstar.workspaceId,
      name: 'Should never exist',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'forbidden' } });
  });

  /**
   * AUD-001, end to end — §12's "denied sensitive attempts are security events".
   *
   * The unit of this is tested in `aud-001-audit.db.test.ts`; what only this file can show is
   * that the wiring survives the real application: a global `APP_GUARD` resolving
   * `AUDIT_SERVICE` from the root injector, an `await` inside `canActivate`, and a row that
   * has landed by the time the 403 reaches the caller. The read is through the admin pool
   * rather than the repository, so it observes the committed row rather than the code path
   * that wrote it.
   */
  it('records the refused attempt as a security event, without leaking it', async () => {
    const session = await signIn(world.atlas.reviewer.id);
    const response = await post('/v1/organizations/northstar-studio/projects', session, {
      workspaceId: world.northstar.workspaceId,
      name: 'Should never exist',
    });
    expect(response.statusCode).toBe(403);

    const correlationId = response.headers['x-correlation-id'];
    const rows = await observe(
      `select action, result, object_type, metadata_json, actor_user_id, organization_id
         from audit_events where correlation_id = ?`,
      [correlationId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!['action']).toBe('security.capability_denied');
    expect(rows[0]!['result']).toBe('denied');
    expect(rows[0]!['object_type']).toBe('capability');
    // Filed under the tenant the request reached, and against the person who tried.
    expect(rows[0]!['organization_id']).toBe(world.northstar.organizationId);
    expect(rows[0]!['actor_user_id']).toBe(world.atlas.reviewer.id);

    const metadata = rows[0]!['metadata_json'] as Record<string, unknown>;
    // The precision the response deliberately drops is kept here, which is the whole point
    // of `ApiError.auditCode` — and the assertion below proves the response still drops it.
    expect(metadata['capability']).toBe('project.create');
    // The *first* of the guard's two ceiling checks, not the second: `client_reviewer` does
    // not hold `project.create` at all, so `hasCapability` refuses before the internal-only
    // check is reached. Asserting the exact code rather than merely "some code" is what makes
    // this a test of which refusal happened.
    expect(metadata['audit_code']).toBe('capability_not_in_role_ceiling');
    expect(metadata['principal_kind']).toBe('client');
    expect(response.body).not.toContain('capability_not_in_role_ceiling');
  });

  it('never returns the denial reason to the caller', async () => {
    const session = await signIn(world.atlas.reviewer.id);
    const response = await post('/v1/organizations/northstar-studio/projects', session, {
      workspaceId: world.northstar.workspaceId,
      name: 'Should never exist',
    });

    // `authorize()` produced a precise `DenialCode`. It belongs in the audit trail; each value
    // describes a fact about something the caller has just been told they cannot see.
    for (const leak of [
      'capability_not_in_role_ceiling',
      'capability_is_internal_only',
      'project.create',
      'client_reviewer',
    ]) {
      expect(response.body).not.toContain(leak);
    }
  });

  it('returns not-found, not forbidden, for another tenant project id', async () => {
    const session = await signIn(world.northstar.owner.id);
    const response = await get(
      `/v1/organizations/northstar-studio/projects/${world.brightops.projectId}`,
      session,
    );
    // 403 would confirm the row exists. Direct-ID enumeration is §11's own case.
    expect(response.statusCode).toBe(404);
  });

  it('returns not-found for a project in this tenant the principal has no relation to', async () => {
    const session = await signIn(world.northstar.designer.id);
    const response = await get(
      `/v1/organizations/northstar-studio/projects/${world.northstar.otherProjectId}`,
      session,
    );
    expect(response.statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('CSRF', () => {
  it('refuses a mutation with no CSRF header', async () => {
    const session = await signIn(world.northstar.owner.id);
    const response = await post(
      '/v1/organizations/northstar-studio/projects',
      session,
      { workspaceId: world.northstar.workspaceId, name: 'Unprotected' },
      { csrf: null },
    );

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'csrf_failed' } });

    const rows = await observe('select count(*) as n from projects where name = ?', [
      'Unprotected',
    ]);
    expect(Number(rows[0]?.['n'])).toBe(0);
  });

  it('refuses a CSRF token bound to a different session', async () => {
    const mine = await signIn(world.northstar.owner.id);
    const theirs = await signIn(world.northstar.manager.id);

    // Cookie tossing: the token is genuine and correctly signed — for another session.
    const response = await post(
      '/v1/organizations/northstar-studio/projects',
      mine,
      { workspaceId: world.northstar.workspaceId, name: 'Tossed' },
      { csrf: theirs.csrfToken },
    );
    expect(response.statusCode).toBe(403);
  });

  it('refuses a CSRF token signed with the wrong secret', async () => {
    const session = await signIn(world.northstar.owner.id);
    const response = await post(
      '/v1/organizations/northstar-studio/projects',
      session,
      { workspaceId: world.northstar.workspaceId, name: 'Forged' },
      { csrf: mintCsrfToken(session.sessionId, 'not the configured secret') },
    );
    expect(response.statusCode).toBe(403);
  });

  it('accepts a correctly-bound token and writes into the caller tenant', async () => {
    const session = await signIn(world.northstar.owner.id);
    const response = await post('/v1/organizations/northstar-studio/projects', session, {
      workspaceId: world.northstar.workspaceId,
      name: 'Bootstrapped by the pipeline',
    });

    expect(response.statusCode).toBe(201);
    const created = response.json<{ id: string; name: string }>();

    // Asserted on the admin connection: the HTTP outcome and the database side effect are two
    // different claims, and §11 requires both.
    const rows = await observe('select organization_id, name from projects where id = ?', [
      created.id,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['organization_id']).toBe(world.northstar.organizationId);
  });

  it('does not require a token for a safe method', async () => {
    const session = await signIn(world.northstar.owner.id);
    expect((await get('/v1/organizations/northstar-studio/projects', session)).statusCode).toBe(
      200,
    );
  });

  it('issues the CSRF token readable and the credentials HttpOnly', async () => {
    const response = (await app.inject({
      method: 'POST',
      url: '/v1/dev/sessions',
      payload: { userId: world.northstar.owner.id },
    })) as unknown as InjectedResponse;

    const cookies = setCookies(response);
    expect(cookies).toHaveLength(3);
    for (const cookie of cookies) {
      const readable = cookie.startsWith('tmanage_session_csrf=');
      expect(/HttpOnly/.test(cookie)).toBe(!readable);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the session routes', () => {
  it('rotates the refresh token and detects a replay, through HTTP', async () => {
    const session = await signIn(world.northstar.owner.id);

    const first = await app.inject({
      method: 'POST',
      url: '/v1/sessions/refresh',
      headers: {
        cookie: `tmanage_session_refresh=${session.refreshToken}`,
        'x-csrf-token': session.csrfToken,
      },
    });
    expect(first.statusCode).toBe(200);

    // The thief replays the token the legitimate client already spent.
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/sessions/refresh',
      headers: {
        cookie: `tmanage_session_refresh=${session.refreshToken}`,
        'x-csrf-token': session.csrfToken,
      },
    });
    expect(replay.statusCode).toBe(401);

    // Reuse revokes the whole session, and the revocation is committed rather than rolled back
    // with the refusal.
    const rows = await observe('select revoked_at, revoked_reason from sessions where id = ?', [
      session.sessionId,
    ]);
    expect(rows[0]?.['revoked_at']).not.toBeNull();
    expect(rows[0]?.['revoked_reason']).toBe('refresh_reuse_detected');
  });

  it('refuses a refresh with no CSRF token and leaves the session usable', async () => {
    const session = await signIn(world.northstar.owner.id);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions/refresh',
      headers: { cookie: `tmanage_session_refresh=${session.refreshToken}` },
    });
    expect(response.statusCode).toBe(401);

    // A CSRF failure is a rejected request, not a compromised session: the credential must
    // still work afterwards. Rotating or revoking here would log the legitimate holder out.
    const rows = await observe('select revoked_at, rotated_at from sessions where id = ?', [
      session.sessionId,
    ]);
    expect(rows[0]?.['revoked_at']).toBeNull();
    expect(rows[0]?.['rotated_at']).toBeNull();
  });

  it('signs out, clears all three cookies, and kills the session immediately', async () => {
    const session = await signIn(world.northstar.owner.id);

    const response = (await app.inject({
      method: 'DELETE',
      url: '/v1/sessions/current',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
    })) as unknown as InjectedResponse;
    expect(response.statusCode).toBe(204);

    const cleared = setCookies(response);
    expect(cleared).toHaveLength(3);
    for (const cookie of cleared) expect(cookie).toMatch(/Max-Age=0/);

    expect((await get('/v1/organizations/northstar-studio/projects', session)).statusCode).toBe(
      401,
    );
  });

  it('refuses a sign-out without a CSRF token', async () => {
    const session = await signIn(world.northstar.owner.id);
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/sessions/current',
      headers: { cookie: session.cookie },
    });

    expect(response.statusCode).toBe(403);
    // Sign-out is a state change like any other. A cross-site page that could log a user out
    // is a nuisance rather than a breach, but it is still a mutation it must not reach.
    const rows = await observe('select revoked_at from sessions where id = ?', [session.sessionId]);
    expect(rows[0]?.['revoked_at']).toBeNull();
  });

  it('lists the caller own sessions and no credential material', async () => {
    const session = await signIn(world.northstar.owner.id);
    const response = await get('/v1/sessions/current/devices', session);

    expect(response.statusCode).toBe(200);
    const { sessions } = response.json<{ sessions: readonly { id: string }[] }>();
    expect(sessions.map((s) => s.id)).toContain(session.sessionId);
    expect(response.body).not.toContain(session.refreshToken);
    expect(response.body).not.toContain('token_hash');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the envelope, the correlation id, and the guard', () => {
  it('echoes a correlation id that is a UUID', async () => {
    const response = await get('/v1/organizations/northstar-studio/projects');
    const echoed = response.headers['x-correlation-id'];
    expect(typeof echoed).toBe('string');
    expect(isUuid(echoed as string)).toBe(true);
    expect(response.json<{ error: { correlationId: string } }>().error.correlationId).toBe(echoed);
  });

  it('honours a caller-supplied correlation id when it is a UUID', async () => {
    const supplied = uuidv7();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/organizations/northstar-studio/projects',
      headers: { 'x-correlation-id': supplied },
    });
    expect(response.headers['x-correlation-id']).toBe(supplied);
  });

  it('ignores a caller-supplied correlation id that is not a UUID', async () => {
    // The value reaches log lines and, later, `audit_events`. An unvalidated header would be
    // attacker-controlled text in the audit trail.
    const response = await app.inject({
      method: 'GET',
      url: '/v1/organizations/northstar-studio/projects',
      headers: { 'x-correlation-id': 'not-a-uuid injected line' },
    });
    expect(isUuid(response.headers['x-correlation-id'] as string)).toBe(true);
  });

  it('keeps the error envelope to a fixed shape', async () => {
    const response = await get('/v1/organizations/northstar-studio/projects');
    const body = response.json<{ error: Record<string, unknown> }>();
    expect(Object.keys(body)).toEqual(['error']);
    expect(Object.keys(body.error).sort()).toEqual(['code', 'correlationId', 'message']);
  });

  it('emits no tenant-guard violation across a whole authenticated request', async () => {
    guardEvents.length = 0;
    const session = await signIn(world.northstar.owner.id);
    await get('/v1/organizations/northstar-studio/projects', session);
    await post('/v1/organizations/northstar-studio/projects', session, {
      workspaceId: world.northstar.workspaceId,
      name: 'Guarded throughout',
    });

    // The membership resolver waives ADR-0001 layer 3 to establish the tenant, and its
    // bootstrap read emits an *audited* event carrying `allowedReason` when it does. That no
    // event lacks a reason means the resolver's reads are the only unscoped ones, and that
    // everything after them — principal assembly, the list, the insert — ran guarded.
    expect(guardEvents.filter((event) => !event.allowedReason)).toEqual([]);
    expect(guardEvents.every((event) => Boolean(event.allowedReason))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the development-only sign-in route', () => {
  it('exists in this configuration, because NODE_ENV is not production', async () => {
    expect(CONFIG.allowDevelopmentSignIn).toBe(true);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/dev/sessions',
      payload: { userId: world.northstar.owner.id },
    });
    expect(response.statusCode).toBe(201);
  });

  it('is not registered at all under a production configuration', async () => {
    const production = await NestFactory.create<NestFastifyApplication>(
      AppModule.register({
        config: { ...CONFIG, allowDevelopmentSignIn: false },
        database: DatabaseModule.forPool({ pool: db.runtime, guardMode: 'enforce' }),
      }),
      new FastifyAdapter(),
      { logger: false },
    );
    await production.init();
    await production.getHttpAdapter().getInstance().ready();

    const response = await production.inject({
      method: 'POST',
      url: '/v1/dev/sessions',
      payload: { userId: world.northstar.owner.id },
    });

    // 404 from the router, not 403 from a guard. A route that exists and refuses is one
    // flipped condition away from existing and succeeding; a route that was never registered
    // has no code path at all.
    expect(response.statusCode).toBe(404);

    await production.close();
  }, 60_000);
});
