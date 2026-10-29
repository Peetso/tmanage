import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { getTableConfig } from 'drizzle-orm/mysql-core';
import type { MySqlTable } from 'drizzle-orm/mysql-core';
import { uuidv7 } from '@tmanage/domain';
import { TABLES } from '../src/common/database/schema.js';
import { TenantDatabase } from '../src/common/database/tenant-context.js';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { mcpResourceUri } from '../src/modules/mcp/mcp-auth.js';
import { mintPersonalAccessToken } from '../src/modules/personal-access-tokens/personal-access-token.js';
import { PlatformAuditService } from '../src/modules/platform-admin/platform-audit.service.js';
import { SupportSessionService } from '../src/modules/platform-admin/support/support-session.service.js';
import { classifyRoute } from '../src/security/route-census.js';
import { bootHttpHarness, reseed, signIn, stopHarness } from './support/http-harness.js';
import type { InjectedResponse, Session } from './support/http-harness.js';
import { liveRoutes } from './support/live-routes.js';
import type { TestDatabase } from './support/test-database.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * SEC-01 — the BOLA corpus (56-04), generated, driven over real HTTP against a real MariaDB.
 *
 * `fixtures/bola-corpus.json` is written by `scripts/security/bola-corpus.mjs` from the
 * controllers; the first test holds it to Nest's own route reflection, so a route added without
 * re-running the script fails here. The two-org world is the seed's: Northstar (the caller) and
 * BrightOps (the victim). One BrightOps row is generated per table the corpus names, from the
 * Drizzle definition — no per-table fixture is written by hand — and its id is substituted into
 * every `:param` and body id field. Each principal kind is a row:
 *
 * | id           | principal                                         | expectation                      |
 * | ------------ | ------------------------------------------------- | -------------------------------- |
 * | AUTH-56-04-1 | Northstar owner, browser session                  | every org route: never 2xx       |
 * | AUTH-56-04-2 | Northstar personal access token                   | every org read: never 2xx        |
 * | AUTH-56-04-3 | Northstar OAuth grant (access token at `/mcp`)    | BrightOps object is not found    |
 * | AUTH-56-04-4 | platform support session opened for Northstar     | every org read: never 2xx        |
 * | AUTH-56-04-5 | Northstar owner (not a platform admin)            | every platform route: never 2xx  |
 * | AUTH-56-04-6 | Northstar owner on session-only routes            | another user's id: never 2xx     |
 * | AUTH-56-04-7 | Northstar owner on id-less org reads              | no BrightOps marker in the body  |
 *
 * Every response body is also scanned for BrightOps markers (names, the generated rows' marker
 * text). Each check is one isolation assertion; the total is printed as `ISOLATION_ASSERTIONS=<n>`
 * for the trust page (`docs/security/isolation-proofs.md`). Positive controls run before and
 * after every sweep, so a principal that silently stopped authenticating cannot pass vacuously.
 */

interface CorpusParam {
  readonly name: string;
  readonly table: string | null;
}
interface CorpusRoute {
  readonly key: string;
  readonly class: 'org' | 'platform' | 'session-only';
  readonly params: readonly CorpusParam[];
  readonly bodyIdFields: readonly CorpusParam[];
  readonly notDriven?: string;
}
interface Corpus {
  readonly fixtureTables: readonly string[];
  readonly routes: readonly CorpusRoute[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = JSON.parse(
  readFileSync(resolve(HERE, 'fixtures/bola-corpus.json'), 'utf8'),
) as Corpus;
const MARKER = 'BOLA-B-MARKER';
const A = 'northstar-studio';
const B_SLUG = 'brightops-consulting';
const TIMEOUT_MS = 15_000;

let app: NestFastifyApplication;
let db: TestDatabase;
let world: SeedWorld;
let owner: Session;
/** Table name → the BrightOps row generated for it (or the seeded one). */
const bRows = new Map<string, string>();
let assertions = 0;
const statuses = new Map<number, number>();

/** Failures of the running sweep, reported together so one run names every finding. */
let failures: string[] = [];
const indistinguishable: string[] = [];

function check(ok: boolean, message: string): void {
  assertions++;
  if (!ok) failures.push(message);
}

function expectSweepClean(): void {
  const found = failures;
  failures = [];
  expect(found, found.join('\n')).toEqual([]);
}

/** `conversation_id` → `conversations`, the same plural rule the generator uses. */
function tableOfColumn(column: string): string | undefined {
  const base = column.replace(/_id$/, '');
  return [`${base}s`, `${base}es`, base.replace(/y$/, 'ies'), base].find((t) => bRows.has(t));
}

/** A value of the column's SQL type; ids point at BrightOps rows wherever one is known. */
function valueFor(column: { name: string; getSQLType(): string }): unknown {
  const type = column.getSQLType().toLowerCase();
  const length = Number(/\((\d+)/.exec(type)?.[1] ?? 255);
  const known: Record<string, string> = {
    organization_id: world.brightops.organizationId,
    workspace_id: world.brightops.workspaceId,
    project_id: world.brightops.projectId,
    work_item_id: world.brightops.workItemId,
    membership_id: world.brightops.owner.membershipId,
    user_id: world.brightops.owner.id,
  };
  if (known[column.name] !== undefined) return known[column.name];
  if (column.name.endsWith('_id')) {
    const table = tableOfColumn(column.name);
    if (table !== undefined) return bRows.get(table);
  }
  if (type.startsWith('enum(')) return /'([^']*)'/.exec(type)?.[1] ?? '';
  if (type.startsWith('char(')) return length === 36 ? uuidv7() : 'b'.repeat(length);
  if (/^(var)?binary/.test(type)) return Buffer.alloc(Math.min(length, 32));
  if (/blob/.test(type)) return Buffer.alloc(1);
  if (type.startsWith('varchar')) return `${MARKER}-${column.name}`.slice(0, length);
  if (/text/.test(type)) return `${MARKER} ${column.name}`;
  if (type.startsWith('json')) return '{}';
  if (type === 'boolean' || /int|decimal|double|float|real/.test(type)) return 0;
  if (type.startsWith('datetime') || type.startsWith('timestamp')) return new Date();
  if (type === 'date') return '2026-01-15';
  if (type.startsWith('time')) return '09:00:00';
  if (type === 'year') return 2026;
  return `${MARKER}`.slice(0, length);
}

/** One BrightOps row per corpus table, generated from its Drizzle definition, FK checks off. */
async function seedVictimRows(): Promise<{ generated: number; unavailable: string[] }> {
  bRows.set('organizations', world.brightops.organizationId);
  bRows.set('workspaces', world.brightops.workspaceId);
  bRows.set('projects', world.brightops.projectId);
  bRows.set('work_items', world.brightops.workItemId);
  bRows.set('memberships', world.brightops.owner.membershipId);
  bRows.set('users', world.brightops.owner.id);
  const tables = TABLES as unknown as Record<string, MySqlTable>;
  const pending = CORPUS.fixtureTables.filter((t) => !bRows.has(t) && tables[t] !== undefined);
  // Ids first, so a row can point at a parent generated after it.
  for (const t of pending)
    if (getTableConfig(tables[t] as MySqlTable).columns.some((c) => c.name === 'id'))
      bRows.set(t, uuidv7());
  const unavailable: string[] = [];
  let generated = 0;
  const conn = await db.admin.getConnection();
  try {
    await conn.query('set foreign_key_checks = 0');
    for (const t of pending) {
      const config = getTableConfig(tables[t] as MySqlTable);
      const cols = config.columns.filter(
        (c) => (c.notNull || c.name === 'organization_id') && c.generated === undefined,
      );
      const values = cols.map((c) => (c.name === 'id' ? bRows.get(t) : valueFor(c)));
      try {
        await conn.query(
          `insert into \`${t}\` (${cols.map((c) => `\`${c.name}\``).join(', ')}) values (?)`,
          [values],
        );
        generated++;
      } catch (error) {
        bRows.delete(t);
        unavailable.push(`${t}: ${(error as Error).message.slice(0, 120)}`);
      }
    }
  } finally {
    await conn.query('set foreign_key_checks = 1');
    conn.release();
  }
  return { generated, unavailable };
}

/** The BrightOps value for a param: its generated row, else an id that exists nowhere. */
function victimValue(p: CorpusParam): string {
  return (p.table !== null ? bRows.get(p.table) : undefined) ?? uuidv7();
}

interface Probe {
  readonly method: string;
  readonly url: string;
  readonly body?: object;
}

/** The route with every id the other tenant's (or, with `value`, any id the caller picks). */
function buildRequest(
  route: CorpusRoute,
  slug: string,
  value: (p: CorpusParam) => string = victimValue,
): Probe {
  const [method, path] = route.key.split(' ') as [string, string];
  let url = path.replace(':orgSlug', slug);
  for (const p of route.params) url = url.replace(`:${p.name}`, encodeURIComponent(value(p)));
  if (method === 'GET') return { method, url };
  const body: Record<string, unknown> = {};
  for (const f of route.bodyIdFields) body[f.name] = f.name.endsWith('Ids') ? [value(f)] : value(f);
  return { method, url, body };
}

/** Bodies compared with every uuid and timestamp blanked: server-made values differ per call. */
const normalize = (body: string): string =>
  body
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<ts>');

async function send(
  req: { method: string; url: string; body?: object },
  headers: Record<string, string>,
): Promise<InjectedResponse> {
  const write = req.method !== 'GET';
  const injected = app.inject({
    method: req.method as 'GET',
    url: req.url,
    headers: { ...headers, ...(write ? { 'content-type': 'application/json' } : {}) },
    ...(write ? { payload: req.body ?? {} } : {}),
  }) as unknown as Promise<InjectedResponse>;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<InjectedResponse>((resolveTimeout) => {
    timer = setTimeout(
      () => resolveTimeout({ statusCode: 599, body: '', headers: {}, json: () => ({}) as never }),
      TIMEOUT_MS,
    );
  });
  const response = await Promise.race([injected, timeout]);
  clearTimeout(timer);
  statuses.set(response.statusCode, (statuses.get(response.statusCode) ?? 0) + 1);
  return response;
}

const sessionHeaders = (s: Session): Record<string, string> => ({
  cookie: s.cookie,
  [CSRF_HEADER]: s.csrfToken,
});

const MARKERS = (): string[] => [
  MARKER,
  'BrightOps Consulting',
  world.brightops.projectName,
  world.brightops.workItemTitle,
  world.brightops.owner.email,
];

const ok2xx = (status: number): boolean => status >= 200 && status <= 299;

/**
 * The isolation assertions every probe makes. A refusal passes. A 2xx passes only when it is
 * indistinguishable from the same call with ids that exist nowhere (same status, same body once
 * server-made ids and timestamps are blanked) — the route treats the foreign id as absent, e.g.
 * an empty aggregate or an idempotent delete — and the response carries no BrightOps data.
 */
async function expectRefused(
  route: CorpusRoute,
  probe: Probe,
  headers: Record<string, string>,
  who: string,
): Promise<void> {
  const response = await send(probe, headers);
  if (ok2xx(response.statusCode)) {
    const slug = probe.url.split('/')[3] ?? A;
    const control = await send(
      buildRequest(route, slug, () => uuidv7()),
      headers,
    );
    const same =
      control.statusCode === response.statusCode &&
      normalize(control.body) === normalize(response.body);
    if (same) indistinguishable.push(`${who}: ${route.key}`);
    check(same, `${who}: ${route.key} → ${response.statusCode} ${response.body.slice(0, 160)}`);
  } else check(true, '');
  expectNoLeak(route.key, response, who);
}

function expectNoLeak(key: string, response: InjectedResponse, who: string): void {
  const leaked = MARKERS().filter((m) => response.body.includes(m));
  check(leaked.length === 0, `${who}: ${key} leaked ${leaked.join(', ')}`);
}

/** The positive control: the principal really is signed in and reads its own organization. */
async function expectOwnReadWorks(headers: Record<string, string>, who: string): Promise<void> {
  const response = await send(
    { method: 'GET', url: `/v1/organizations/${A}/work-items/${world.northstar.workItemId}` },
    headers,
  );
  expect(response.statusCode, `${who} positive control: ${response.body.slice(0, 200)}`).toBe(200);
}

const driven = (cls: CorpusRoute['class']): CorpusRoute[] =>
  CORPUS.routes.filter((r) => r.class === cls && r.notDriven === undefined);

beforeAll(async () => {
  ({ app, db } = await bootHttpHarness({ secretTag: 'sec_001_bola_corpus' }));
  world = await reseed(db);
  const seeded = await seedVictimRows();
  console.log(
    `bola fixtures: ${seeded.generated} generated, ${seeded.unavailable.length} unavailable` +
      (seeded.unavailable.length ? `\n  ${seeded.unavailable.join('\n  ')}` : ''),
  );
  owner = await signIn(app, world.northstar.owner.id);
}, 300_000);

afterAll(async () => {
  console.log(`bola statuses: ${JSON.stringify(Object.fromEntries([...statuses].sort()))}`);
  if (indistinguishable.length > 0)
    console.log(
      `bola 2xx indistinguishable from a nonexistent id:\n  ${indistinguishable.join('\n  ')}`,
    );
  console.log(`ISOLATION_ASSERTIONS=${assertions}`);
  await stopHarness({ app, db });
});

describe('SEC-01 BOLA corpus (56-04)', () => {
  it('the corpus matches the live routes (re-run scripts/security/bola-corpus.mjs if not)', () => {
    const live = liveRoutes()
      .filter((r) => !r.isPublic && typeof classifyRoute(r) === 'string')
      .map((r) => r.key)
      .sort();
    const corpus = CORPUS.routes.map((r) => r.key).sort();
    expect(corpus).toEqual(live);
  });

  it('AUTH-56-04-1: a Northstar session never reaches a BrightOps object on any org route', async () => {
    await expectOwnReadWorks(sessionHeaders(owner), 'session');
    for (const route of driven('org'))
      await expectRefused(route, buildRequest(route, A), sessionHeaders(owner), 'session');
    await expectOwnReadWorks(sessionHeaders(owner), 'session (after)');
    // Every BrightOps row the writes aimed at is still there: no 2xx above deleted one.
    for (const [table, id] of bRows) {
      const [rows] = await db.admin.query<RowDataPacket[]>(
        `select count(*) as n from \`${table}\` where id = ?`,
        [id],
      );
      check(Number(rows[0]?.['n']) === 1, `BrightOps ${table} row ${id} did not survive the sweep`);
    }
    expectSweepClean();
  }, 600_000);

  it('AUTH-56-04-7: id-less org reads carry no BrightOps data', async () => {
    for (const route of CORPUS.routes.filter(
      (r) => r.class === 'org' && r.notDriven !== undefined && r.key.startsWith('GET '),
    ))
      expectNoLeak(route.key, await send(buildRequest(route, A), sessionHeaders(owner)), 'read');
    expectSweepClean();
  }, 600_000);

  it('AUTH-56-04-5: every platform route refuses an owner who is not a platform admin', async () => {
    for (const route of CORPUS.routes.filter((r) => r.class === 'platform'))
      await expectRefused(route, buildRequest(route, A), sessionHeaders(owner), 'platform');
    expectSweepClean();
  }, 600_000);

  it("AUTH-56-04-6: session-only routes refuse another user's id", async () => {
    for (const route of CORPUS.routes.filter((r) => r.class === 'session-only')) {
      if (route.params.length > 0)
        await expectRefused(route, buildRequest(route, A), sessionHeaders(owner), 'self');
      else if (route.key.startsWith('GET ') && !route.key.endsWith(' /mcp/'))
        expectNoLeak(route.key, await send(buildRequest(route, A), sessionHeaders(owner)), 'self');
    }
    await expectOwnReadWorks(sessionHeaders(owner), 'session (after self routes)');
    expectSweepClean();
  }, 600_000);

  it('AUTH-56-04-2: a Northstar personal access token never reaches BrightOps', async () => {
    const minted = mintPersonalAccessToken();
    await db.admin.execute(
      `insert into personal_access_tokens
         (id, organization_id, membership_id, user_id, name, token_hash, token_prefix, created_at)
       values (?, ?, ?, ?, 'BOLA corpus', ?, ?, now(3))`,
      [
        uuidv7(),
        world.northstar.organizationId,
        world.northstar.owner.membershipId,
        world.northstar.owner.id,
        minted.tokenHash,
        minted.displayPrefix,
      ],
    );
    const headers = { authorization: `Bearer ${minted.token}` };
    await expectOwnReadWorks(headers, 'pat');
    for (const route of driven('org').filter((r) => r.key.startsWith('GET ')))
      await expectRefused(route, buildRequest(route, A), headers, 'pat');
    const other = await send(
      { method: 'GET', url: `/v1/organizations/${B_SLUG}/home/my-day` },
      headers,
    );
    check(other.statusCode === 404, `pat against the BrightOps slug → ${other.statusCode}`);
    await expectOwnReadWorks(headers, 'pat (after)');
    expectSweepClean();
  }, 600_000);

  it('AUTH-56-04-3: a Northstar OAuth grant cannot read a BrightOps object at /mcp or on REST', async () => {
    const clientPk = uuidv7();
    const grantId = uuidv7();
    const token = randomBytes(32).toString('base64url');
    await db.admin.execute(
      `insert into oauth_clients (id, client_id, kind, name, redirect_uris_json, verified, created_at)
       values (?, ?, 'dcr', 'BOLA corpus client', '["https://client.example/cb"]', 1, now(3))`,
      [clientPk, `bola-${clientPk}`],
    );
    await db.admin.execute(
      `insert into oauth_grants (id, organization_id, client_pk, membership_id, user_id, scopes, created_at)
       values (?, ?, ?, ?, ?, 'tmanage:read tmanage:write', now(3))`,
      [
        grantId,
        world.northstar.organizationId,
        clientPk,
        world.northstar.owner.membershipId,
        world.northstar.owner.id,
      ],
    );
    await db.admin.execute(
      `insert into oauth_access_tokens (token_hash, grant_id, family_id, audience, scopes, expires_at, created_at)
       values (?, ?, ?, ?, 'tmanage:read tmanage:write', date_add(now(3), interval 30 minute), now(3))`,
      [
        createHash('sha256').update(token, 'utf8').digest('hex'),
        grantId,
        uuidv7(),
        mcpResourceUri({ apiPublicUrl: 'http://localhost:4000' }),
      ],
    );
    const mcp = (name: string, args: Record<string, unknown>) =>
      send(
        {
          method: 'POST',
          url: '/mcp',
          body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
        },
        { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
      );
    const own = await mcp('work_items_get', { workItemId: world.northstar.workItemId });
    expect(own.body, 'oauth positive control').toContain(world.northstar.workItemTitle);
    const foreign = await mcp('work_items_get', { workItemId: world.brightops.workItemId });
    const result = JSON.parse(foreign.body) as { result?: { isError?: boolean } };
    check(
      result.result?.isError === true,
      `oauth work_items_get(BrightOps) → ${foreign.body.slice(0, 200)}`,
    );
    expectNoLeak('POST /mcp work_items_get', foreign, 'oauth');
    expectNoLeak('POST /mcp projects_list', await mcp('projects_list', {}), 'oauth');
    const rest = await send(
      { method: 'GET', url: `/v1/organizations/${A}/work-items/${world.brightops.workItemId}` },
      { authorization: `Bearer ${token}` },
    );
    check(
      rest.statusCode < 200 || rest.statusCode > 299,
      `oauth token on REST → ${rest.statusCode}`,
    );
    expectNoLeak('GET work item (REST, oauth)', rest, 'oauth');
    expectSweepClean();
  }, 120_000);

  it('AUTH-56-04-4: a support session opened for Northstar cannot read BrightOps', async () => {
    const support = await signIn(app, world.platformAdmin.id);
    const [rows] = await db.admin.query<RowDataPacket[]>(
      'select id from sessions where user_id = ? order by created_at desc limit 1',
      [world.platformAdmin.id],
    );
    const tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
    await new SupportSessionService(tenant, new PlatformAuditService(tenant)).start(
      {
        account: {
          userId: world.platformAdmin.id,
          email: world.platformAdmin.email,
          displayName: world.platformAdmin.displayName,
          emailVerified: true,
          mfaEnabled: false,
        },
        sessionId: String(rows[0]?.['id']),
        stepUp: { expiresAt: new Date(Date.now() + 10 * 60_000), mfaVerified: false },
        permissions: ['platform.orgs.enter'],
      },
      world.northstar.organizationId,
      { minutes: 60, reason: 'BOLA corpus support-mode row' },
      { correlationId: uuidv7(), ip: '203.0.113.9', userAgent: 'vitest' },
    );
    const headers = sessionHeaders(support);
    await expectOwnReadWorks(headers, 'support');
    for (const route of driven('org').filter((r) => r.key.startsWith('GET ')))
      await expectRefused(route, buildRequest(route, A), headers, 'support');
    const other = await send(
      {
        method: 'GET',
        url: `/v1/organizations/${B_SLUG}/work-items/${world.brightops.workItemId}`,
      },
      headers,
    );
    check(
      other.statusCode === 404 || other.statusCode === 403,
      `support in BrightOps → ${other.statusCode}`,
    );
    expectNoLeak('support in BrightOps', other, 'support');
    await expectOwnReadWorks(headers, 'support (after)');
    expectSweepClean();
  }, 600_000);
});
