import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { uuidv7 } from '@tmanage/domain';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { apiConfigFrom } from '../src/common/http/api-config.js';
import type { ApiConfig, ApiConfigSource } from '../src/common/http/api-config.js';
import { mintPersonalAccessToken } from '../src/modules/personal-access-tokens/personal-access-token.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * PAT-001 — a personal access token is bound to the organization it was created in (0202).
 *
 * The attack this proves closed: a token's member belongs to more than one organization, so a
 * token that only resolved to its member could be pointed at any of them. The seed's Northstar
 * owner is additionally made a full member of BrightOps here, and a token is created against her
 * Northstar membership. The token is accepted in Northstar and refused in BrightOps — with the
 * same 404 a non-member gets — even though its member is a legitimate BrightOps owner.
 */

const ENV: ApiConfigSource = {
  NODE_ENV: 'test',
  SESSION_COOKIE_NAME: 'tmanage_session',
  SESSION_SECRET: 'local_dev_only_session_secret_for_the_pat_isolation_suite',
  SESSION_TTL_SECONDS: 900,
  REFRESH_TTL_SECONDS: 1_209_600,
  CSRF_SECRET: 'local_dev_only_csrf_secret_for_the_pat_isolation_suite_x',
  AUTH_MFA_SEED_KEYS: '1:local_dev_only_mfa_seed_key_change_me_00000',
  API_PUBLIC_URL: 'http://localhost:4000',
  AUTH_MAX_FAILURES_IN_WINDOW: 5,
  AUTH_FAILURE_WINDOW_SECONDS: 900,
  AUTH_TOTP_ISSUER: 'TManage',
  CLIENT_MEMBERSHIP_DEFAULT_EXPIRY_DAYS: 180,
  RATE_LIMIT_AUTH_WINDOW_SECONDS: 300,
  RATE_LIMIT_AUTH_MAX_PER_SOURCE: 1000,
  RATE_LIMIT_AUTH_MAX_REQUESTS: 1000,
  RATE_LIMIT_AUTH_MAX_GLOBAL: 10_000,
};
const CONFIG: ApiConfig = apiConfigFrom(ENV);

interface InjectedResponse {
  readonly statusCode: number;
  readonly body: string;
}

let db: TestDatabase;
let app: NestFastifyApplication;
let world: SeedWorld;
let token: string;

/** GET a tenant-scoped read with a Bearer personal access token and no cookie. */
async function getWithToken(orgSlug: string): Promise<InjectedResponse> {
  return (await app.inject({
    method: 'GET',
    url: `/v1/organizations/${orgSlug}/home/my-day`,
    headers: { authorization: `Bearer ${token}` },
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

  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);

  // The Northstar owner is a legitimate owner of BrightOps too — the second org the token must
  // NOT reach, despite the membership.
  await db.admin.execute(
    `insert into memberships (id, organization_id, user_id, role, has_org_wide_scope)
     values (?, ?, ?, 'owner', true)`,
    [uuidv7(), world.brightops.organizationId, world.northstar.owner.id],
  );

  // A token bound to her Northstar membership, inserted the way creation stores it: only the hash.
  const minted = mintPersonalAccessToken();
  token = minted.token;
  await db.admin.execute(
    `insert into personal_access_tokens
       (id, organization_id, membership_id, user_id, name, token_hash, token_prefix, created_at)
     values (?, ?, ?, ?, 'MCP (laptop)', ?, ?, now(3))`,
    [
      uuidv7(),
      world.northstar.organizationId,
      world.northstar.owner.membershipId,
      world.northstar.owner.id,
      minted.tokenHash,
      minted.displayPrefix,
    ],
  );
}, 300_000);

afterAll(async () => {
  await app?.close();
  await db?.stop();
});

describe('PAT-001 personal access token tenant isolation', () => {
  it('accepts the token in the organization it was created in', async () => {
    const response = await getWithToken('northstar-studio');
    expect(response.statusCode).toBe(200);
  });

  it('refuses the token in another organization its member belongs to, with a 404', async () => {
    const response = await getWithToken('brightops-consulting');
    expect(response.statusCode).toBe(404);
  });
});
