import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import { FilesystemObjectStore, ObjectNotFoundError, createPartAdmission } from '@tmanage/storage';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { StorageModule } from '../src/common/storage/storage.module.js';
import { ScannerModule } from '../src/common/scan/scanner.module.js';
import { StubScanner } from '../src/common/scan/malware-scanner.js';
import type { ApiConfig } from '../src/common/http/api-config.js';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { createFastifyAdapter, PART_CONTENT_TYPE } from '../src/common/http/fastify-adapter.js';
import { FILE_SCANNER, FILE_VERIFIER } from '../src/common/http/tokens.js';
import type { FileVerifier } from '../src/modules/files/file-verifier.js';
import type { FileScanner } from '../src/modules/files/file-scanner.js';
import { signReauthToken } from '../src/modules/identity/reauth-token.js';
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
 * PRIV-002 — the privacy wipe, proven against the real database, the real filesystem store and the
 * stub scanner (audit 2026-10-26 gap 4, NFR-09 / H3). What only this suite proves:
 *
 * 1. **The export archive carries the bytes.** A company export of a studio with a ready file is
 *    built by the privacy pass into the private zone; unpacked, its `file_contents` section holds
 *    that file byte for byte, marked `clean`.
 * 2. **The erasure waits for its date, then really removes rows.** A due company deletion closes the
 *    company and erases nothing; once the erasure delay after closing has passed, one pass empties
 *    every erasable tenant table of that company — a threaded chat (self-referencing rows), a client
 *    portal access log (0233's narrowed trigger), an MCP connector grant with its global tokens —
 *    removes the stored file's bytes, sets `purged_at`, keeps the audit trail and the organization
 *    row, and leaves both other studios' rows exactly as they were. A second pass finds nothing.
 * 3. **The portal access log stays append-only for a live company.**
 */

let db: TestDatabase;
let store: FilesystemObjectStore;
let world: SeedWorld;
let app: NestFastifyApplication;
let verifier: FileVerifier;
let scanner: FileScanner;
let root: string;

const SECRET_TAG = 'the_priv_002_suite';
const NORTHSTAR = 'northstar-studio';
const PART_SIZE = 16;
const SIGNING_SECRET = 'a_storage_signing_secret_for_the_priv_002_suite_xxxx';
const CONFIG: ApiConfig = {
  ...testApiConfig(SECRET_TAG),
  storageOrgBytesLimit: 1_000_000,
  uploadMaxBytes: 5_000,
  uploadUrlTtlSeconds: 900,
  uploadPartSizeBytes: PART_SIZE,
};

const PDF = (() => {
  const head = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n', 'latin1');
  return Buffer.concat([head, Buffer.alloc(128 - head.length, 0x20)]);
})();
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

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
  headers: Record<string, string> = {},
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
      ...headers,
    },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  })) as unknown as InjectedResponse;
}

let keyCounter = 0;
const freshKey = (): string => `priv-002-key-${String(++keyCounter).padStart(8, '0')}`;

/** Open, PUT every part, complete, verify and scan: a `ready` deliverable of the Atlas project. */
async function readyFile(session: PrivacySession): Promise<{ id: string; objectKey: string }> {
  const opened = await send(
    'POST',
    '/upload-sessions',
    session,
    {
      fileName: 'brief.pdf',
      mimeType: 'application/pdf',
      projectId: world.northstar.projectId,
      purpose: 'deliverable',
      sizeBytes: PDF.length,
      contentHash: sha256(PDF),
    },
    { 'idempotency-key': freshKey() },
  );
  if (opened.statusCode !== 201) throw new Error(`open: ${opened.statusCode} ${opened.body}`);
  const upload = opened.json<{
    id: string;
    fileAssetId: string;
    uploadUrls: { partNumber: number; url: string }[];
  }>();
  const parts: { partNumber: number; etag: string }[] = [];
  for (const target of upload.uploadUrls) {
    const url = new URL(target.url);
    const part = PDF.subarray((target.partNumber - 1) * PART_SIZE, target.partNumber * PART_SIZE);
    const response = (await app.inject({
      method: 'PUT',
      url: `${url.pathname}${url.search}`,
      headers: { 'content-type': PART_CONTENT_TYPE },
      payload: part,
    })) as unknown as InjectedResponse;
    if (response.statusCode !== 200) throw new Error(`PUT: ${response.statusCode}`);
    parts.push({ partNumber: target.partNumber, etag: String(response.headers['etag']) });
  }
  const completed = await send('POST', `/upload-sessions/${upload.id}/complete`, session, {
    parts,
  });
  if (completed.statusCode !== 202) {
    throw new Error(`complete: ${completed.statusCode} ${completed.body}`);
  }
  await verifier.verify();
  await scanner.scan();
  const [asset] = await observe('select status from file_assets where id = ?', [
    upload.fileAssetId,
  ]);
  expect(asset!['status']).toBe('ready');
  const [version] = await observe('select object_key from file_versions where file_asset_id = ?', [
    upload.fileAssetId,
  ]);
  return { id: upload.fileAssetId, objectKey: String(version!['object_key']) };
}

async function readObject(zone: 'private' | 'quarantine', objectKey: string): Promise<Buffer> {
  const opened = await store.openObject({ zone, objectKey });
  const chunks: Buffer[] = [];
  for await (const chunk of opened.stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
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

const nonEmpty = (counts: Record<string, number>) =>
  Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0));

const pass = () => app.get<symbol, PrivacyPass>(PRIVACY_PASS, { strict: false });

beforeAll(async () => {
  db = await startTestDatabase();
  root = mkdtempSync(join(tmpdir(), 'tmanage-priv-002-'));
  store = new FilesystemObjectStore({
    root,
    signingSecret: SIGNING_SECRET,
    publicUrl: 'http://localhost:4000',
    partSizeBytes: PART_SIZE,
  });
  app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      config: CONFIG,
      database: DatabaseModule.forPool({ pool: db.runtime, guardMode: 'enforce' }),
      storage: StorageModule.forLocalStore(store),
      scanner: ScannerModule.forScanner(new StubScanner()),
    }),
    createFastifyAdapter({
      uploadPartSizeBytes: PART_SIZE,
      admitPart: createPartAdmission(SIGNING_SECRET, () => Date.now()),
    }),
    { logger: false, abortOnError: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  verifier = app.get<FileVerifier>(FILE_VERIFIER);
  scanner = app.get<FileScanner>(FILE_SCANNER);
}, 300_000);

beforeEach(async () => {
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
});

afterAll(async () => {
  await app?.close();
  await db?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('PRIV-002 — the company export carries the file bytes', () => {
  it('builds an archive whose file_contents section holds the ready file byte for byte', async () => {
    const file = await readyFile(await signIn(world.northstar.manager.id));
    const owner = await signIn(world.northstar.owner.id);
    const requested = await send('POST', '/admin/privacy/exports', owner, { kind: 'company' });
    expect(requested.statusCode, requested.body).toBe(201);

    const report = await pass().run();
    expect(report.built).toBe(1);
    expect(report.failed).toBe(0);

    const [row] = await observe('select status, object_key, scan_status from privacy_exports');
    expect(row!['status']).toBe('ready');
    expect(row!['scan_status']).toBe('clean');
    const archive = JSON.parse(
      gunzipSync(await readObject('private', String(row!['object_key']))).toString('utf8'),
    ) as { kind: string; sections: Record<string, readonly Record<string, unknown>[]> };
    expect(archive.kind).toBe('company');

    const contents = archive.sections['file_contents'] ?? [];
    const entry = contents.find((candidate) => candidate['file_id'] === file.id);
    expect(entry, JSON.stringify(contents)).toBeDefined();
    expect(entry).toMatchObject({ included: true, scan_status: 'clean', size_bytes: PDF.length });
    expect(Buffer.compare(Buffer.from(String(entry!['content_base64']), 'base64'), PDF)).toBe(0);
  });
});

describe('PRIV-002 — the erasure after a company deletion', () => {
  it('waits for the erasure date, then removes every row and file of the company and only it', async () => {
    const northstar = world.northstar.organizationId;
    const manager = await signIn(world.northstar.manager.id);
    const owner = await signIn(world.northstar.owner.id);

    // ── What the company holds besides the seed ──────────────────────────────
    const file = await readyFile(manager);
    expect(Buffer.compare(await readObject('private', file.objectKey), PDF)).toBe(0);

    const channel = await send('POST', '/conversations', manager, {
      projectId: world.northstar.projectId,
      name: 'atlas-relaunch',
    });
    expect(channel.statusCode, channel.body).toBe(201);
    const channelId = channel.json<{ id: string }>().id;
    const rootMessage = await send('POST', `/conversations/${channelId}/messages`, manager, {
      body: 'The question',
    });
    expect(rootMessage.statusCode, rootMessage.body).toBe(201);
    const reply = await send('POST', `/conversations/${channelId}/messages`, owner, {
      body: 'The answer',
      parentMessageId: rootMessage.json<{ id: string }>().id,
    });
    expect(reply.statusCode, reply.body).toBe(201);

    const logId = uuidv7();
    await db.admin.execute(
      `insert into portal_access_log (id, organization_id, project_id, client_member_id, resource_kind)
       values (?, ?, ?, ?, 'project')`,
      [logId, northstar, world.northstar.projectId, world.atlas.reviewer.membershipId],
    );

    const clientPk = uuidv7();
    const grantId = uuidv7();
    const tokenHash = sha256(Buffer.from(`priv-002-token-${grantId}`));
    await db.admin.execute(
      `insert into oauth_clients (id, client_id, kind, name, redirect_uris_json)
       values (?, ?, 'dcr', 'Claude', json_array('https://claude.ai/api/mcp/auth_callback'))`,
      [clientPk, `priv-002-${clientPk}`],
    );
    await db.admin.execute(
      `insert into oauth_grants (id, organization_id, client_pk, membership_id, user_id, scopes)
       values (?, ?, ?, ?, ?, 'tmanage:read')`,
      [grantId, northstar, clientPk, world.northstar.owner.membershipId, world.northstar.owner.id],
    );
    await db.admin.execute(
      `insert into oauth_access_tokens (token_hash, grant_id, family_id, audience, scopes, expires_at)
       values (?, ?, ?, '/mcp', 'tmanage:read', date_add(utc_timestamp(3), interval 1 hour))`,
      [tokenHash, grantId, uuidv7()],
    );

    // The portal access log is append-only while the company is live (0109, narrowed by 0233).
    await expect(
      db.admin.execute('delete from portal_access_log where id = ?', [logId]),
    ).rejects.toThrow(/append-only/u);

    const twinBefore = await rowCounts(world.twin.organizationId);
    const brightopsBefore = await rowCounts(world.brightops.organizationId);
    const held = {
      messages: 2,
      portal_access_log: 1,
      oauth_grants: 1,
      file_assets: 1,
      file_versions: 1,
    };
    expect(nonEmpty(await rowCounts(northstar))).toMatchObject(held);

    // ── The company deletion: scheduled, then due ─────────────────────────────
    const [org] = await observe('select name from organizations where id = ?', [northstar]);
    const scheduled = await send('POST', '/admin/privacy/deletion', owner, {
      confirmName: String(org!['name']),
    });
    expect(scheduled.statusCode, scheduled.body).toBe(201);
    expect((await pass().run()).deletionsExecuted).toBe(0);

    await db.admin.execute(
      `update privacy_deletion_requests
          set scheduled_for = date_sub(utc_timestamp(3), interval 1 day),
              requested_at = date_sub(utc_timestamp(3), interval 31 day)`,
    );
    const closing = await pass().run();
    expect(closing.deletionsExecuted).toBe(1);
    expect(closing.companiesErased).toBe(0);

    // Closed, but inside the erasure delay: nothing is erased yet.
    const [closed] = await observe('select archived_at from organizations where id = ?', [
      northstar,
    ]);
    expect(closed!['archived_at']).not.toBeNull();
    expect(nonEmpty(await rowCounts(northstar))).toMatchObject(held);
    expect((await pass().run()).companiesErased).toBe(0);
    expect(Buffer.compare(await readObject('private', file.objectKey), PDF)).toBe(0);

    const auditsBefore = Number(
      (
        await observe('select count(*) as c from audit_events where organization_id = ?', [
          northstar,
        ])
      )[0]!['c'],
    );

    // ── Past the erasure date ─────────────────────────────────────────────────
    await db.admin.execute(
      `update privacy_deletion_requests set executed_at = date_sub(executed_at, interval 25 hour)`,
    );
    const erasing = await pass().run();
    expect(erasing.companiesErased).toBe(1);

    expect(nonEmpty(await rowCounts(northstar))).toEqual({});
    await expect(readObject('private', file.objectKey)).rejects.toBeInstanceOf(ObjectNotFoundError);
    expect(await observe('select token_hash from oauth_access_tokens')).toHaveLength(0);
    // The global client registration is not the company's: it stays.
    expect(await observe('select id from oauth_clients where id = ?', [clientPk])).toHaveLength(1);

    const [request] = await observe(
      'select status, purged_at from privacy_deletion_requests where organization_id = ?',
      [northstar],
    );
    expect(request!['status']).toBe('executed');
    expect(request!['purged_at']).not.toBeNull();
    expect(await observe('select id from organizations where id = ?', [northstar])).toHaveLength(1);

    // The audit trail is kept, and the erasure itself is on it.
    const audits = await observe(
      `select action, metadata_json as metadata from audit_events where organization_id = ?`,
      [northstar],
    );
    expect(audits.length).toBeGreaterThan(auditsBefore);
    const erased = audits
      .filter((audit) => audit['action'] === 'privacy_deletion.executed')
      .map(
        (audit) =>
          (typeof audit['metadata'] === 'string'
            ? JSON.parse(audit['metadata'] as string)
            : audit['metadata']) as Record<string, unknown>,
      )
      .find((metadata) => metadata['step'] === 'erased');
    expect(erased).toMatchObject({ kind: 'company' });
    expect(Number(erased!['files_removed'])).toBeGreaterThanOrEqual(1);
    expect(Number(erased!['rows_erased'])).toBeGreaterThan(0);

    // The other studios are exactly as they were.
    expect(await rowCounts(world.twin.organizationId)).toEqual(twinBefore);
    expect(await rowCounts(world.brightops.organizationId)).toEqual(brightopsBefore);

    // A second pass finds nothing left to do.
    expect((await pass().run()).companiesErased).toBe(0);
  });
});
