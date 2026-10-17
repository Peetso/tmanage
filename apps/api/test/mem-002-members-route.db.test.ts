import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { apiConfigFrom } from '../src/common/http/api-config.js';
import type { ApiConfig } from '../src/common/http/api-config.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * MEM-002 — `GET /v1/organizations/:orgSlug/members` over real HTTP.
 *
 * `members-directory.test.ts` proves the statement the repository builds and the capability the
 * route declares, both without a server. What only this suite can reach is the route itself:
 * the Nest wiring resolving the controller's two injected tokens, the four guards admitting an
 * internal member and refusing a client principal *on this path*, `:orgSlug` resolving to a
 * membership the caller actually holds, and the join answering with rows a seeded fixture put
 * there. A missing `@Inject` under esbuild produces an application that starts cleanly and
 * 500s on every request, which is precisely the failure no unit test can see.
 *
 * It is modelled on `proj-001-project-creation.db.test.ts`'s workspace-list block, because the
 * controller is a line-for-line sibling of `WorkspacesController` and the two should be proved
 * the same way — a difference between these two files should mean a difference in the code.
 *
 * Four cases, one per behaviour the D16 scope file names for task 2, and no more.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const SESSION_SECRET = 'local_dev_only_session_secret_for_the_members_suite_xx';
const CSRF_SECRET = 'local_dev_only_csrf_secret_for_the_members_suite_xxxxxx';

const CONFIG: ApiConfig = apiConfigFrom({
  NODE_ENV: 'test',
  ALLOW_DEV_SIGN_IN: true,
  SESSION_COOKIE_NAME: 'tmanage_session',
  SESSION_SECRET,
  SESSION_TTL_SECONDS: 900,
  REFRESH_TTL_SECONDS: 1_209_600,
  CSRF_SECRET,
  AUTH_MFA_SEED_KEYS: '1:local_dev_only_mfa_seed_key_change_me_00000',
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

interface MemberView {
  readonly userId: string;
  readonly displayName: string;
  readonly role: string;
  readonly status: string;
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

async function signIn(userId: string): Promise<{ cookie: string }> {
  const response = (await app.inject({
    method: 'POST',
    url: '/v1/dev/sessions',
    headers: { 'content-type': 'application/json' },
    payload: { userId },
  })) as unknown as InjectedResponse;
  return { cookie: cookieHeader(setCookies(response)) };
}

async function listMembers(slug: string, session: { cookie: string }): Promise<InjectedResponse> {
  return (await app.inject({
    method: 'GET',
    url: `/v1/organizations/${slug}/members`,
    headers: { cookie: session.cookie },
  })) as unknown as InjectedResponse;
}

beforeAll(async () => {
  db = await startTestDatabase();
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
});

afterAll(async () => {
  await app?.close();
  await db?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the member directory over HTTP', () => {
  it('answers an ordinary member with this organization’s people, by name', async () => {
    const session = await signIn(world.northstar.designer.id);
    const response = await listMembers('northstar-studio', session);

    expect(response.statusCode).toBe(200);
    const { members } = response.json<{ members: readonly MemberView[] }>();

    // D16's point: a person, not a UUID to paste.
    const names = members.map((member) => member.displayName).sort();
    // Rania Farouk is the seed's disposable subject for the member-admin and offboarding journeys
    // (see seed-two-tenants.ts); she is an active member of this organization, so the directory
    // names her alongside the three principals.
    expect(names).toEqual(['Lina Samir', 'Maya Hassan', 'Omar Adel', 'Rania Farouk']);
    expect(members.every((member) => member.status === 'active')).toBe(true);

    // The adversarial twin's owner is called "Maya Hasan" and her organization id differs from
    // Northstar's in the final hex digit alone. A statement that lost its tenant predicate, or
    // a join that anchored the wrong side, puts her in this list.
    expect(names).not.toContain('Maya Hasan');
    expect(names).not.toContain('Tarek Said');
    // No address book: the directory answers "who", not "how to reach them".
    expect(response.body).not.toContain('@northstar.example');
  });

  it('refuses a client principal, who must never be handed the agency’s roster', async () => {
    // Youssef is a client reviewer of Atlas Hospitality, a client of this same organization —
    // so the slug resolves for him and only the capability ceiling stands between him and the
    // staff list. `work.read` is in no client ceiling, which is what makes this a 403.
    const session = await signIn(world.atlas.reviewer.id);
    const response = await listMembers('northstar-studio', session);

    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('Maya Hassan');
  });

  it('answers 200 with only the caller when the organization has nobody else', async () => {
    // BrightOps has exactly one membership. An organization with nobody else in it is not an
    // error state a client can act on differently from an error, so it is an ordinary page.
    const session = await signIn(world.brightops.owner.id);
    const response = await listMembers('brightops-consulting', session);

    expect(response.statusCode).toBe(200);
    const { members, nextAfter } = response.json<{
      members: readonly MemberView[];
      nextAfter: string | null;
    }>();

    expect(members.map((member) => member.userId)).toEqual([world.brightops.owner.id]);
    expect(members.filter((member) => member.userId !== world.brightops.owner.id)).toEqual([]);
    // A short page has no next one; the cursor is not a membership id handed out for free.
    expect(nextAfter).toBeNull();
  });

  it('refuses an organization the caller has no membership in', async () => {
    // Northstar's owner naming BrightOps' slug. The refusal is the membership resolver's, and
    // it is a 404 rather than a 403 on purpose — slugs are company names, so a caller able to
    // tell "exists but not yours" from "does not exist" can enumerate the customer base.
    const session = await signIn(world.northstar.owner.id);
    const response = await listMembers('brightops-consulting', session);

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('Tarek Said');
  });
});
