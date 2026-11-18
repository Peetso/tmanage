import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import { FilesystemObjectStore, createPartAdmission } from '@tmanage/storage';
import { AppModule } from '../src/app.module.js';
import { TABLES } from '../src/common/database/schema.js';
import { TENANT_TABLES } from '../src/common/database/tenant-guard.js';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { StorageModule } from '../src/common/storage/storage.module.js';
import { ScannerModule } from '../src/common/scan/scanner.module.js';
import { StubScanner } from '../src/common/scan/malware-scanner.js';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { createFastifyAdapter } from '../src/common/http/fastify-adapter.js';
import { signReauthToken } from '../src/modules/identity/reauth-token.js';
import { mintPersonalAccessToken } from '../src/modules/personal-access-tokens/personal-access-token.js';
import { PRIVACY_PASS } from '../src/modules/privacy/privacy.module.js';
import { PRIVACY_REAUTH_HEADER } from '../src/modules/privacy/privacy-step-up.js';
import type { PrivacyPass } from '../src/modules/privacy/privacy-job.js';
import { erasableTables } from '../src/modules/privacy/privacy-erasure.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { signIn as harnessSignIn, testApiConfig } from './support/http-harness.js';
import type { InjectedResponse, Session } from './support/http-harness.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * PRIV-53-52 (53 §53-20 audit debt) — the data inventory is the erasure's contract.
 *
 * `docs/security/data-inventory.md` lists every table in `TABLES` with its personal fields, its
 * erasure rule (`delete` | `pseudonymise` | `keep-fiscal-redacted` | `none-no-personal-data`), what
 * is done today (`enforced` | `gap` | `n/a`) and the owner item. This suite:
 *
 * 1. **Parses the inventory** and fails on any `TABLES` entry missing from it (proved once with a
 *    mutated copy that drops a row), on an unknown rule, and on a `gap` row without an owner.
 * 2. **Runs an erasure through the privacy job** (`privacy-job.ts`) on the two-org fixture: Lina, a
 *    Northstar-only member holding a session, a personal access token and an MCP grant, deletes her
 *    account (the job offboards her), then the owner deletes the company (the job closes it, and a
 *    day later erases it). Then every `delete`/`pseudonymise` row marked `enforced` holds nothing
 *    of Northstar's, so no personal value of Lina's; her session and token are refused; the audit
 *    trail is still there; BrightOps is exactly as it was.
 *
 * 56-18 replaces the seed inventory with the fuller one; this contract stays.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const INVENTORY_PATH = resolve(HERE, '../../../docs/security/data-inventory.md');

const RULES = ['delete', 'pseudonymise', 'keep-fiscal-redacted', 'none-no-personal-data'] as const;
type Rule = (typeof RULES)[number];
// `retained` (56-18 follow-up, 2026-11-16): kept on purpose, the reason in the notes.
const STATUSES = ['enforced', 'retained', 'gap', 'n/a'] as const;
type Status = (typeof STATUSES)[number];

interface InventoryRow {
  readonly table: string;
  readonly fields: readonly string[];
  readonly rule: string;
  readonly status: string;
  readonly owner: string;
}

/** The inventory table's rows: `| \`table\` | fields | \`rule\` | today | owner | notes |`. */
function parseInventory(markdown: string): InventoryRow[] {
  const rows: InventoryRow[] = [];
  for (const line of markdown.split(/\r?\n/u)) {
    const match = /^\| `([a-z0-9_]+)`\s*\|(.*)$/u.exec(line);
    if (!match) continue;
    const cells = (match[2] ?? '').split('|').map((cell) => cell.trim());
    const unquote = (cell: string | undefined) => (cell ?? '').replace(/`/gu, '').trim();
    rows.push({
      table: match[1] ?? '',
      fields: (cells[0] ?? '')
        .split(',')
        .map(unquote)
        .filter((field) => field !== '' && field !== '-'),
      rule: unquote(cells[1]),
      status: unquote(cells[2]),
      owner: unquote(cells[3]),
    });
  }
  return rows;
}

/** What the inventory gets wrong against the schema: tables missing, unknown, doubled, mislabeled. */
function inventoryProblems(rows: readonly InventoryRow[], tables: readonly string[]) {
  const listed = rows.map((row) => row.table);
  return {
    missing: tables.filter((table) => !listed.includes(table)),
    unknown: listed.filter((table) => !tables.includes(table)),
    doubled: listed.filter((table, index) => listed.indexOf(table) !== index),
    badRule: rows.filter((row) => !RULES.includes(row.rule as Rule)).map((row) => row.table),
    badStatus: rows.filter((row) => !STATUSES.includes(row.status as Status)).map((r) => r.table),
    gapWithoutOwner: rows
      .filter((row) => row.status === 'gap' && !/\d{2}-\d{2}/u.test(row.owner))
      .map((row) => row.table),
  };
}

const NO_PROBLEMS = {
  missing: [],
  unknown: [],
  doubled: [],
  badRule: [],
  badStatus: [],
  gapWithoutOwner: [],
};

const TABLE_NAMES = Object.keys(TABLES);
const INVENTORY = parseInventory(readFileSync(INVENTORY_PATH, 'utf8'));

describe('PRIV-53-52 — the inventory covers the schema', () => {
  it('lists every TABLES entry exactly once, with a known rule and status', () => {
    expect(inventoryProblems(INVENTORY, TABLE_NAMES)).toEqual(NO_PROBLEMS);
    expect(INVENTORY).toHaveLength(TABLE_NAMES.length);
  });

  it('fails when a table is deleted from the inventory (mutated copy)', () => {
    const dropped = INVENTORY[Math.floor(INVENTORY.length / 2)]!;
    const mutated = INVENTORY.filter((row) => row.table !== dropped.table);
    expect(inventoryProblems(mutated, TABLE_NAMES).missing).toEqual([dropped.table]);
  });

  it('claims the company erasure only for tables the erasure really empties', () => {
    const erasable = new Set(erasableTables());
    const claimed = INVENTORY.filter(
      (row) => row.status === 'enforced' && TENANT_TABLES[row.table] === 'organization_id',
    );
    expect(claimed.filter((row) => !erasable.has(row.table)).map((row) => row.table)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const SECRET_TAG = 'the_priv_053_erasure_inventory_suite';
const NORTHSTAR = 'northstar-studio';
const SIGNING_SECRET = 'a_storage_signing_secret_for_the_priv_053_suite_xxxxx';
const CONFIG = testApiConfig(SECRET_TAG);

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;
let root: string;

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

type PrivacySession = Session & { readonly reauthToken: string };

async function signIn(userId: string): Promise<PrivacySession> {
  const session = await harnessSignIn(app, userId);
  const [row] = await observe(
    'select id from sessions where user_id = ? order by id desc limit 1',
    [userId],
  );
  const reauthToken = signReauthToken(
    { userId, sessionId: String(row!['id']), expiresAt: new Date(Date.now() + 300_000) },
    CONFIG.sessionSecret,
  );
  return { ...session, reauthToken };
}

async function send(
  method: 'GET' | 'POST',
  path: string,
  session: PrivacySession,
  payload?: unknown,
): Promise<InjectedResponse> {
  const body = payload ?? (method === 'POST' ? {} : undefined);
  const stepUp = method === 'POST' && /\/privacy\/(exports|deletion)$/u.test(path);
  return (await app.inject({
    method,
    url: `/v1/organizations/${NORTHSTAR}${path}`,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      cookie: session.cookie,
      ...(method === 'GET' ? {} : { [CSRF_HEADER]: session.csrfToken }),
      ...(stepUp ? { [PRIVACY_REAUTH_HEADER]: session.reauthToken } : {}),
    },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  })) as unknown as InjectedResponse;
}

async function withToken(token: string): Promise<InjectedResponse> {
  return (await app.inject({
    method: 'GET',
    url: `/v1/organizations/${NORTHSTAR}/home/my-day`,
    headers: { authorization: `Bearer ${token}` },
  })) as unknown as InjectedResponse;
}

/** Rows per erasable tenant table for one organization (tables that do not exist are skipped). */
async function rowCounts(organizationId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of erasableTables()) {
    try {
      const [row] = await observe(
        `select count(*) as c from \`${table}\` where organization_id = ?`,
        [organizationId],
      );
      counts[table] = Number(row!['c']);
    } catch (error) {
      if ((error as { errno?: number }).errno === 1146) continue;
      throw error;
    }
  }
  return counts;
}

/** Make every still-scheduled deletion due: its grace period ended yesterday. */
async function makeDue(): Promise<void> {
  await db.admin.execute(
    `update privacy_deletion_requests
        set scheduled_for = date_sub(utc_timestamp(3), interval 1 day),
            requested_at = date_sub(utc_timestamp(3), interval 31 day)
      where status = 'scheduled'`,
  );
}

const pass = () => app.get<symbol, PrivacyPass>(PRIVACY_PASS, { strict: false });

beforeAll(async () => {
  db = await startTestDatabase();
  root = mkdtempSync(join(tmpdir(), 'tmanage-priv-053-'));
  const store = new FilesystemObjectStore({
    root,
    signingSecret: SIGNING_SECRET,
    publicUrl: 'http://localhost:4000',
    partSizeBytes: 16,
  });
  app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      config: CONFIG,
      database: DatabaseModule.forPool({ pool: db.runtime, guardMode: 'enforce' }),
      storage: StorageModule.forLocalStore(store),
      scanner: ScannerModule.forScanner(new StubScanner()),
    }),
    createFastifyAdapter({
      uploadPartSizeBytes: 16,
      admitPart: createPartAdmission(SIGNING_SECRET, () => Date.now()),
    }),
    { logger: false, abortOnError: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
}, 300_000);

afterAll(async () => {
  await app?.close();
  await db?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('PRIV-53-52 — an erasure through the privacy job honours the inventory', () => {
  it('leaves no personal value in an enforced row, revokes access and keeps the audit trail', async () => {
    const northstar = world.northstar.organizationId;
    const lina = world.northstar.designer;

    // ── What Lina holds: a session, a personal access token and an MCP grant with a token ──
    const linaSession = await signIn(lina.id);
    expect((await send('GET', '/work-items', linaSession)).statusCode).toBe(200);

    const minted = mintPersonalAccessToken();
    await db.admin.execute(
      `insert into personal_access_tokens
         (id, organization_id, membership_id, user_id, name, token_hash, token_prefix, created_at)
       values (?, ?, ?, ?, 'MCP (laptop)', ?, ?, now(3))`,
      [uuidv7(), northstar, lina.membershipId, lina.id, minted.tokenHash, minted.displayPrefix],
    );
    expect((await withToken(minted.token)).statusCode).toBe(200);

    const clientPk = uuidv7();
    const grantId = uuidv7();
    await db.admin.execute(
      `insert into oauth_clients (id, client_id, kind, name, redirect_uris_json)
       values (?, ?, 'dcr', 'Claude', json_array('https://claude.ai/api/mcp/auth_callback'))`,
      [clientPk, `priv-053-${clientPk}`],
    );
    await db.admin.execute(
      `insert into oauth_grants (id, organization_id, client_pk, membership_id, user_id, scopes)
       values (?, ?, ?, ?, ?, 'tmanage:read')`,
      [grantId, northstar, clientPk, lina.membershipId, lina.id],
    );
    await db.admin.execute(
      `insert into oauth_access_tokens (token_hash, grant_id, family_id, audience, scopes, expires_at)
       values (?, ?, ?, '/mcp', 'tmanage:read', date_add(utc_timestamp(3), interval 1 hour))`,
      [createHash('sha256').update(`priv-053-${grantId}`).digest('hex'), grantId, uuidv7()],
    );

    const brightopsBefore = await rowCounts(world.brightops.organizationId);

    // ── 1. Lina deletes her account; the job offboards her once the grace period ends ──
    expect((await send('POST', '/me/privacy/deletion', linaSession)).statusCode).toBe(201);
    await makeDue();
    expect((await pass().run()).deletionsExecuted).toBe(1);
    const [membership] = await observe('select status from memberships where id = ?', [
      lina.membershipId,
    ]);
    expect(membership!['status']).toBe('offboarded');
    // Her session and her token no longer reach the company.
    expect([401, 403, 404]).toContain((await send('GET', '/work-items', linaSession)).statusCode);
    expect([401, 403, 404]).toContain((await withToken(minted.token)).statusCode);

    // ── 2. The owner deletes the company; the job closes it, and a day later erases it ──
    const owner = await signIn(world.northstar.owner.id);
    const [org] = await observe('select name from organizations where id = ?', [northstar]);
    const scheduled = await send('POST', '/admin/privacy/deletion', owner, {
      confirmName: String(org!['name']),
    });
    expect(scheduled.statusCode, scheduled.body).toBe(201);
    await makeDue();
    expect((await pass().run()).deletionsExecuted).toBe(1);
    await db.admin.execute(
      `update privacy_deletion_requests set executed_at = date_sub(executed_at, interval 25 hour)
        where kind = 'company'`,
    );
    expect((await pass().run()).companiesErased).toBe(1);

    // ── Every enforced delete/pseudonymise row holds nothing of the erased company or person ──
    const residue: Record<string, number> = {};
    for (const row of INVENTORY) {
      if (row.status !== 'enforced' || (row.rule !== 'delete' && row.rule !== 'pseudonymise')) {
        continue;
      }
      // A tenant table is checked by company, an OAuth table by the erased grant. A global
      // per-person or age-out table (sessions, mail_queue, rate_limit_buckets …) holds no
      // company key: its rule is carried out by AccountErasure or its named purge, which this
      // company journey does not reach, so it is not judged here.
      const byGrant =
        TENANT_TABLES[row.table] !== 'organization_id' &&
        Number(
          (
            await observe(
              `select count(*) as c from information_schema.columns
              where table_schema = database() and table_name = ? and column_name = 'grant_id'`,
              [row.table],
            )
          )[0]?.['c'],
        ) !== 0;
      if (TENANT_TABLES[row.table] !== 'organization_id' && !byGrant) continue;
      const [count] =
        TENANT_TABLES[row.table] === 'organization_id'
          ? await observe(`select count(*) as c from \`${row.table}\` where organization_id = ?`, [
              northstar,
            ])
          : await observe(`select count(*) as c from \`${row.table}\` where grant_id = ?`, [
              grantId,
            ]);
      if (Number(count!['c']) > 0) residue[row.table] = Number(count!['c']);
    }
    expect(residue).toEqual({});
    expect(
      await observe('select id from personal_access_tokens where user_id = ?', [lina.id]),
    ).toHaveLength(0);
    expect([401, 403, 404]).toContain((await withToken(minted.token)).statusCode);

    // ── The audit trail is kept (a `keep-fiscal-redacted` row), and names both erasures ──
    const audits = await observe(
      `select action from audit_events where organization_id = ? and action = 'privacy_deletion.executed'`,
      [northstar],
    );
    expect(audits.length).toBeGreaterThanOrEqual(3); // account, company closed, company erased
    expect(await observe('select id from organizations where id = ?', [northstar])).toHaveLength(1);

    // ── The other organization of the two-org fixture is exactly as it was ──
    expect(await rowCounts(world.brightops.organizationId)).toEqual(brightopsBefore);
  });
});
