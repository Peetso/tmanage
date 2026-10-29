import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { PLATFORM_PERMISSIONS, auditObjectTypeFor, uuidv7 } from '@tmanage/domain';
import { FilesystemObjectStore } from '@tmanage/storage';
import {
  createExportJobStore,
  createWorkerDatabase,
  filesystemExportWriter,
  runExportJobs,
} from '@tmanage/worker';
import type { WorkerDatabase } from '@tmanage/worker';
import { TenantDatabase } from '../src/common/database/tenant-context.js';
import { PlatformAdminRepository } from '../src/modules/platform-admin/platform-admin.repository.js';
import type { PlatformAdminActor } from '../src/modules/platform-admin/platform-admin.guard.js';
import { PlatformAuditService } from '../src/modules/platform-admin/platform-audit.service.js';
import { ActivityRepository } from '../src/modules/platform-admin/activity/activity.repository.js';
import { PlatformActivityService } from '../src/modules/platform-admin/activity/activity.service.js';
import { ExportsRepository } from '../src/modules/platform-admin/activity/exports.repository.js';
import { SupportSessionsRepository } from '../src/modules/platform-admin/support/support-sessions.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * PLAT-020 against a real server — CSV exports (platform-admin v2, PA-09, 0246).
 *
 * 1. Requesting an export writes the queued job and `platform.export_requested` together.
 * 2. The worker pass claims it, writes the CSV under `<root>/objects/private/<key>` (only the
 *    filtered organization's rows, no metadata), and stamps ready + row count + 24 h expiry;
 *    the API download streams the same bytes.
 * 3. Sign-ins are written by the API at once (the worker never reads the security log).
 * 4. Over the row cap fails with "narrow the filter".
 * 5. Delete is an UPDATE (`status = 'deleted'`, audited); the next pass removes the file. An
 *    expired file is refused with "run it again", and the pass marks it expired and removes it.
 */

let db: TestDatabase;
let world: SeedWorld;
let service: PlatformActivityService;
let workerDb: WorkerDatabase;
let root = '';

const ctx = {
  correlationId: '0199aa00-0000-7000-8000-00000000c020',
  ip: '203.0.113.20',
  userAgent: 'Firefox/131',
};
const ACTION = 'project_membership.granted';

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

function actor(): PlatformAdminActor {
  return {
    account: {
      userId: world.platformAdmin.id,
      email: world.platformAdmin.email,
      displayName: 'Peter',
      emailVerified: true,
      mfaEnabled: true,
    },
    sessionId: uuidv7(),
    stepUp: null,
    source: 'env',
    preset: 'super_admin',
    permissions: [...PLATFORM_PERMISSIONS],
  };
}

async function auditEvent(organizationId: string, actorUserId: string): Promise<string> {
  const id = uuidv7();
  await db.admin.query(
    `insert into audit_events
       (id, organization_id, actor_user_id, effective_actor_id, action, object_type, object_id,
        result, correlation_id, metadata_json, created_at)
     values (?, ?, ?, ?, ?, ?, ?, 'allowed', ?, ?, current_timestamp(3))`,
    [
      id,
      organizationId,
      actorUserId,
      actorUserId,
      ACTION,
      auditObjectTypeFor(ACTION),
      uuidv7(),
      uuidv7(),
      JSON.stringify({ project_id: 'secret-metadata-marker' }),
    ],
  );
  return id;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

async function job(id: string): Promise<RowDataPacket | undefined> {
  const [row] = await observe(
    `select status, row_count, object_key, error, expires_at, finished_at
       from platform_export_jobs where id = ?`,
    [id],
  );
  return row;
}

function pass(cap?: number) {
  return runExportJobs(
    createExportJobStore(workerDb),
    filesystemExportWriter(root),
    cap === undefined ? {} : { cap },
  );
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  root = mkdtempSync(join(tmpdir(), 'tmanage-exports-'));
  const store = new FilesystemObjectStore({
    root,
    signingSecret: 'plat-020-signing-secret-at-least-32-chars!!',
    publicUrl: 'http://127.0.0.1:1',
    partSizeBytes: 5 * 1024 * 1024,
  });
  const tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  service = new PlatformActivityService({
    admins: new PlatformAdminRepository(tenant),
    activity: new ActivityRepository(tenant),
    exports: new ExportsRepository(tenant),
    supportSessions: new SupportSessionsRepository(tenant),
    audit: new PlatformAuditService(tenant),
    allowlist: [world.platformAdmin.email],
    objectStore: store,
  });
  workerDb = createWorkerDatabase({ url: db.url, connectionLimit: 2, statementTimeoutMs: 15_000 });
  await auditEvent(world.northstar.organizationId, world.northstar.owner.id);
  await auditEvent(world.northstar.organizationId, world.northstar.manager.id);
  await auditEvent(world.twin.organizationId, world.twin.owner.id);
});

afterAll(async () => {
  await workerDb?.end();
  await db?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('C6 exports', () => {
  let actionsJob = '';

  it('queues the job and audits the request in one go', async () => {
    const view = await service.createExport(
      actor(),
      { scope: 'actions', filter: { organizationId: world.northstar.organizationId, junk: 'x' } },
      ctx,
    );
    actionsJob = view.id;
    expect(view).toMatchObject({
      scope: 'actions',
      status: 'queued',
      filter: { organizationId: world.northstar.organizationId },
    });
    const audits = await observe(
      `select target_id from platform_admin_audit_events
        where action = 'platform.export_requested' and target_id = ?`,
      [view.id],
    );
    expect(audits).toHaveLength(1);
  });

  it('the worker writes the file and the API streams it back', async () => {
    const result = await pass();
    expect(result.written).toBeGreaterThanOrEqual(1);
    const row = await job(actionsJob);
    expect(row?.['status']).toBe('ready');
    expect(Number(row?.['row_count'])).toBe(2);
    const key = String(row?.['object_key']);
    expect(key).toMatch(new RegExp(`^platform/exports/${actionsJob}/[0-9a-f]{32}\\.csv$`, 'u'));
    const onDisk = await readFile(join(root, 'objects', 'private', ...key.split('/')), 'utf8');
    expect(onDisk.split('\r\n')[0]).toContain('Organization ID');
    expect(onDisk).not.toContain('secret-metadata-marker');
    expect(onDisk).not.toContain(world.twin.organizationId);
    expect(new Date(String(row?.['expires_at'])).getTime()).toBeGreaterThan(Date.now());
    const download = await service.download(actionsJob, ctx);
    expect(download.fileName).toMatch(/^tmanage-actions-\d{4}-\d{2}-\d{2}\.csv$/u);
    expect(await readAll(download.stream)).toBe(onDisk);
  });

  it('writes a sign-ins export at once, in the API', async () => {
    await db.admin.query(
      `insert into authentication_events (id, user_id, action, outcome, reason, ip, occurred_at)
       values (?, ?, 'password_sign_in', 'succeeded', null, '41.33.10.8', now(3))`,
      [uuidv7(), world.northstar.owner.id],
    );
    const view = await service.createExport(actor(), { scope: 'sign-ins' }, ctx);
    const row = await job(view.id);
    expect(row?.['status']).toBe('ready');
    const download = await service.download(view.id, ctx);
    expect(await readAll(download.stream)).toContain(world.northstar.owner.email);
  });

  it('fails a job over the row cap with a message to narrow the filter', async () => {
    const view = await service.createExport(actor(), { scope: 'actions' }, ctx);
    await pass(1);
    const row = await job(view.id);
    expect(row?.['status']).toBe('failed');
    expect(String(row?.['error'])).toContain('Narrow the filter');
    expect(row?.['object_key']).toBeNull();
  });

  it('delete is an update, and the next pass removes the file', async () => {
    const before = await job(actionsJob);
    const key = String(before?.['object_key']);
    await service.deleteExport(actor(), actionsJob, { reason: 'Sent to the owner' }, ctx);
    const [deleted] = await observe('select status from platform_export_jobs where id = ?', [
      actionsJob,
    ]);
    expect(deleted?.['status']).toBe('deleted');
    const list = await service.listExports(ctx);
    expect(list.exports.map((entry) => entry.id)).not.toContain(actionsJob);
    await pass();
    await expect(stat(join(root, 'objects', 'private', ...key.split('/')))).rejects.toThrow();
    const [after] = await observe('select object_key from platform_export_jobs where id = ?', [
      actionsJob,
    ]);
    expect(after?.['object_key']).toBeNull();
    const audits = await observe(
      `select reason from platform_admin_audit_events
        where action = 'platform.export_deleted' and target_id = ?`,
      [actionsJob],
    );
    expect(audits[0]?.['reason']).toBe('Sent to the owner');
  });

  it('an expired file is refused, then marked expired and removed', async () => {
    const view = await service.createExport(
      actor(),
      { scope: 'platform', filter: { action: 'platform.export_requested' } },
      ctx,
    );
    await pass();
    const ready = await job(view.id);
    expect(ready?.['status']).toBe('ready');
    const key = String(ready?.['object_key']);
    await db.admin.query('update platform_export_jobs set expires_at = ? where id = ?', [
      new Date(Date.now() - 60_000),
      view.id,
    ]);
    await expect(service.download(view.id, ctx)).rejects.toMatchObject({
      status: 404,
      message: 'This export has expired. Run it again.',
    });
    await pass();
    const expired = await job(view.id);
    expect(expired?.['status']).toBe('expired');
    expect(expired?.['object_key']).toBeNull();
    await expect(stat(join(root, 'objects', 'private', ...key.split('/')))).rejects.toThrow();
  });
});
