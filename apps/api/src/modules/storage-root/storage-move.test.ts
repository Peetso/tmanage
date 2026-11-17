import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { ObjectStore } from '@tmanage/storage';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { StorageConnectionRow, StorageMigrationJobRow } from '../../common/database/schema.js';
import { ProviderObjectUnavailableError } from '../files/provider-objects.js';
import type { ProviderObjectSource } from '../files/provider-objects.js';
import { StorageMovePass } from './storage-move-job.js';
import type { MoveOptions } from './storage-move-job.js';
import { StorageMoveRepository } from './storage-move.repository.js';
import type { MoveCandidate } from './storage-move.repository.js';
import { StorageMoveService } from './storage-move.service.js';

/**
 * 57-13b "Move to Drive". Fakes only: a scripted job repository, an in-memory local store and a
 * provider source that records every call, so the order of copy, verify, flip and delete is seen.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';
const JOB = '01890000-0000-7000-8000-0000000000j1';
const BYTES = Buffer.from('the brief, as uploaded');
const HASH = createHash('sha256').update(BYTES).digest('hex');

const database = {
  read: (_c: TenantContext, work: (runner: unknown) => Promise<unknown>) => work({}),
  transaction: (_c: TenantContext, work: (runner: unknown) => Promise<unknown>) => work({}),
  bootstrapRead: (_o: unknown, work: (runner: unknown) => Promise<unknown>) => work({}),
} as unknown as TenantDatabase;

const options: MoveOptions = {
  batch: 10,
  pauseMs: 0,
  now: () => new Date(0),
  sleep: () => Promise.resolve(),
  log: () => undefined,
};

function connection(patch: Partial<StorageConnectionRow> = {}): StorageConnectionRow {
  return {
    id: 'conn-1',
    organizationId: ORG,
    provider: 'google_drive',
    status: 'connected',
    refreshTokenEnc: 'sealed',
    rootFolderId: 'root-1',
    ...patch,
  } as StorageConnectionRow;
}

function job(patch: Partial<StorageMigrationJobRow> = {}): StorageMigrationJobRow {
  return {
    id: JOB,
    organizationId: ORG,
    activeOrganizationId: ORG,
    kind: 'transient_to_provider',
    backend: 'google_drive',
    storageConnectionId: 'conn-1',
    status: 'queued',
    total: 1,
    moved: 0,
    failed: 0,
    skipped: 0,
    movedBytes: 0,
    totalBytes: 0,
    cursorVersionId: null,
    pendingObjectKey: null,
    error: null,
    createdAt: new Date(0),
    finishedAt: null,
    ...patch,
  } as StorageMigrationJobRow;
}

function candidate(patch: Partial<MoveCandidate> = {}): MoveCandidate {
  return {
    id: 'v1',
    organizationId: ORG,
    fileAssetId: 'f1',
    name: 'brief.pdf',
    mimeType: 'application/pdf',
    objectKey: `tenant/${ORG}/object-v1`,
    sizeBytes: BYTES.length,
    contentHash: HASH,
    storageBackend: 'local',
    providerFileId: null,
    storageConnectionId: null,
    ...patch,
  };
}

/** A pass over one job with one scripted batch; `events` is the order things happened in. */
function harness(input: {
  readonly files?: readonly MoveCandidate[];
  readonly echo?: Buffer;
  readonly put?: () => Promise<{ connectionId: string; providerFileId: string }>;
  readonly job?: StorageMigrationJobRow;
  readonly flip?: boolean;
}) {
  const events: string[] = [];
  let row = input.job ?? job();
  let batches = [input.files ?? [candidate()]];
  const jobs = {
    organizationsWithLiveJobs: () => Promise.resolve([ORG]),
    findActive: () => Promise.resolve(row),
    findById: () => Promise.resolve(row),
    claim: () => Promise.resolve(true),
    release: () => Promise.resolve(events.push('release')),
    nextCandidates: () => {
      const [next, ...rest] = batches;
      batches = rest;
      return Promise.resolve(next ?? []);
    },
    flip: (_r: unknown, _c: unknown, id: string) => {
      events.push(`flip:${id}`);
      return Promise.resolve(input.flip ?? true);
    },
    advance: (_r: unknown, _c: unknown, _j: unknown, step: { moved: number; failed: number }) => {
      events.push(`advance:${step.moved ? 'moved' : step.failed ? 'failed' : 'skipped'}`);
      return Promise.resolve();
    },
    clearPending: () => Promise.resolve(events.push('clearPending')),
    finish: (_r: unknown, _c: unknown, _j: unknown, status: string, error: string | null) => {
      events.push(`finish:${status}:${error ?? ''}`);
      row = { ...row, status: status as StorageMigrationJobRow['status'], error };
      return Promise.resolve(true);
    },
  } as unknown as StorageMoveRepository;
  const store = {
    openObject: ({ objectKey }: { objectKey: string }) => {
      events.push(`local.read:${objectKey}`);
      return Promise.resolve({ sizeBytes: BYTES.length, stream: Readable.from([BYTES]) });
    },
    remove: ({ zone, objectKey }: { zone: string; objectKey: string }) => {
      events.push(`local.remove:${zone}:${objectKey}`);
      return Promise.resolve();
    },
  } as unknown as Pick<ObjectStore, 'openObject' | 'remove'>;
  const source: ProviderObjectSource = {
    put: () => {
      events.push('provider.put');
      return input.put
        ? input.put()
        : Promise.resolve({ connectionId: 'conn-1', providerFileId: 'p1' });
    },
    read: () => {
      events.push('provider.read');
      return Promise.resolve(input.echo ?? BYTES);
    },
    remove: () => {
      events.push('provider.remove');
      return Promise.resolve();
    },
  };
  const pass = new StorageMovePass(
    database,
    store,
    { google_drive: source },
    {
      record: () => {
        events.push('audit');
        return Promise.resolve({} as never);
      },
    },
    options,
    jobs,
    { findConnection: () => Promise.resolve(connection()) },
    { append: () => Promise.resolve('event-1') },
    { releaseUsed: () => Promise.resolve(events.push('counter.release') > 0) },
    {
      record: () => {
        events.push('ledger');
        return Promise.resolve();
      },
    },
  );
  return { pass, events };
}

describe('57-13b move job — one file', () => {
  it('copies, verifies, flips and only then deletes the local copy', async () => {
    const { pass, events } = harness({});
    const report = await pass.run();
    expect(report.moved).toBe(1);
    const flip = events.indexOf('flip:v1');
    const remove = events.indexOf(`local.remove:private:tenant/${ORG}/object-v1`);
    expect(events.indexOf('provider.put')).toBeLessThan(events.indexOf('provider.read'));
    expect(events.indexOf('provider.read')).toBeLessThan(flip);
    // Fails if the delete is ever moved before the flip's commit.
    expect(flip).toBeGreaterThan(-1);
    expect(remove).toBeGreaterThan(flip);
    expect(events.indexOf('counter.release')).toBeGreaterThan(flip);
    expect(events.indexOf('clearPending')).toBeGreaterThan(remove);
  });

  it('keeps the local copy when the provider copy does not hash to the file', async () => {
    const { pass, events } = harness({ echo: Buffer.from('the brief, but changed') });
    const report = await pass.run();
    // Fails if the read-back SHA-256 check is removed: the file would be flipped and deleted.
    expect(report).toMatchObject({ moved: 0, failed: 1 });
    expect(events).not.toContain('flip:v1');
    expect(events.some((event) => event.startsWith('local.remove'))).toBe(false);
    expect(events).toContain('provider.remove');
  });

  it('never copies a local object whose bytes are not the recorded content hash', async () => {
    const { pass, events } = harness({ files: [candidate({ contentHash: 'f'.repeat(64) })] });
    expect(await pass.run()).toMatchObject({ moved: 0, failed: 1 });
    expect(events).not.toContain('provider.put');
    expect(events.some((event) => event.startsWith('local.remove'))).toBe(false);
  });

  it('stops cleanly on a revoked grant and deletes nothing', async () => {
    const { pass, events } = harness({
      put: () => Promise.reject(new ProviderObjectUnavailableError('not_connected')),
    });
    const report = await pass.run();
    expect(report).toMatchObject({ moved: 0, finished: 1 });
    expect(events).toContain('finish:stopped:not_connected');
    expect(events).not.toContain('flip:v1');
    expect(events.some((event) => event.startsWith('local.remove'))).toBe(false);
  });

  it("never reads, copies or deletes another workspace's file", async () => {
    const foreign = candidate({ id: 'v9', organizationId: OTHER, objectKey: `tenant/${OTHER}/x` });
    const { pass, events } = harness({ files: [foreign] });
    expect(await pass.run()).toMatchObject({ moved: 0, skipped: 1 });
    expect(events.some((event) => event.includes(OTHER))).toBe(false);
    expect(events).not.toContain('provider.put');
  });

  it('leaves the local copy when another pass flipped the version first', async () => {
    const { pass, events } = harness({ flip: false });
    expect(await pass.run()).toMatchObject({ moved: 0, skipped: 1 });
    expect(events.some((event) => event.startsWith('local.remove'))).toBe(false);
    expect(events).toContain('provider.remove');
  });

  it('finishes a delete a crash left pending before moving anything else', async () => {
    const { pass, events } = harness({
      job: job({ status: 'running', pendingObjectKey: `tenant/${ORG}/object-v0` }),
      files: [],
    });
    await pass.run();
    expect(events[0]).toBe(`local.remove:private:tenant/${ORG}/object-v0`);
    expect(events).toContain('finish:done:');
  });
});

describe('57-13b move job — the candidates query', () => {
  it("binds the caller's organization on both the version and the file", async () => {
    const statements: { sql: string; params: readonly unknown[] }[] = [];
    const runner = {
      query: (sql: string, params: readonly unknown[]) => {
        statements.push({ sql, params });
        return Promise.resolve([]);
      },
    };
    const context = { organizationId: ORG, correlationId: 'c' } as unknown as TenantContext;
    await new StorageMoveRepository().nextCandidates(runner as never, context, '', 10);
    const [statement] = statements;
    expect(statement?.sql).toContain('`file_versions`.`organization_id` = ?');
    expect(statement?.sql).toContain('`file_assets`.`organization_id` = ?');
    expect(statement?.sql).toContain('`file_versions`.`storage_backend` = ?');
    expect(statement?.params.filter((value) => value === ORG)).toHaveLength(2);
    expect(statement?.params).not.toContain(OTHER);
  });

  it("counts only the caller's local versions for the card, and binds the file limit", async () => {
    const statements: { sql: string; params: readonly unknown[] }[] = [];
    const runner = {
      query: (sql: string, params: readonly unknown[]) => {
        statements.push({ sql, params });
        return Promise.resolve([[4, '3650722201', 3]]);
      },
    };
    const context = { organizationId: ORG, correlationId: 'c' } as unknown as TenantContext;
    const figures = await new StorageMoveRepository().localFigures(runner as never, context, 100);
    const [statement] = statements;
    expect(statement?.sql).toContain('`file_versions`.`organization_id` = ?');
    expect(statement?.sql).toContain('`file_assets`.`organization_id` = ?');
    expect(statement?.params.filter((value) => value === ORG)).toHaveLength(2);
    expect(statement?.params).toContain(100);
    expect(figures).toEqual({ files: 4, bytes: 3650722201, movable: 3 });
  });
});

describe('57-13b start and status', () => {
  const principal = (role: string) =>
    ({
      userId: '01890000-0000-7000-8000-00000000a001',
      organizationId: ORG,
      kind: 'internal',
      role,
      membershipId: 'm-1',
      membershipStatus: 'active',
      clientOrganizationId: null,
      projectIds: [],
      hasOrgWideScope: true,
    }) as unknown as Principal;
  const context = { organizationId: ORG, correlationId: 'c' } as unknown as TenantContext;

  function service() {
    const inserted: unknown[] = [];
    const jobs = {
      findActive: () => Promise.resolve(undefined),
      measureCandidates: () => Promise.resolve({ files: 3, bytes: 7340032 }),
      findLatest: () => Promise.resolve(job({ status: 'done', moved: 3, totalBytes: 7340032 })),
      localFigures: (_r: unknown, _c: unknown, max: number) =>
        Promise.resolve({ files: 2, bytes: 120 * 1024 * 1024, movable: max > 0 ? 1 : 0 }),
      insert: (_r: unknown, _c: unknown, row: unknown) => Promise.resolve(inserted.push(row)),
      findById: () => Promise.resolve(job({ total: 3 })),
    } as unknown as StorageMoveRepository;
    const requested: string[] = [];
    const moves = new StorageMoveService(
      database,
      { record: () => Promise.resolve({} as never) },
      { request: () => requested.push('request') },
      jobs,
      { findConnection: () => Promise.resolve(connection()) },
      () => new Date(0),
    );
    return { moves, inserted, requested };
  }

  it('lets an owner start a move to the connected provider, and wakes the job', async () => {
    const { moves, inserted, requested } = service();
    const view = await moves.start(context, principal('owner'), { provider: 'google_drive' });
    expect(view).toMatchObject({ id: JOB, status: 'queued', total: 3, provider: 'google_drive' });
    expect(inserted).toEqual([
      expect.objectContaining({
        backend: 'google_drive',
        storageConnectionId: 'conn-1',
        total: 3,
        totalBytes: 7340032,
      }),
    ]);
    expect(requested).toEqual(['request']);
  });

  it('refuses a Member (AUTH-57-22) before anything is read', async () => {
    const { moves, inserted } = service();
    await expect(
      moves.start(context, principal('member'), { provider: 'google_drive' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(moves.status(context, principal('member'), JOB)).rejects.toMatchObject({
      status: 403,
    });
    expect(inserted).toEqual([]);
  });

  it('gives the latest job with its planned bytes and what is still on TManage', async () => {
    const { moves } = service();
    const latest = await moves.latest(context, principal('owner'));
    expect(latest.job).toMatchObject({ status: 'done', totalBytes: 7340032 });
    expect(latest.onTManage).toEqual({ files: 2, bytes: 120 * 1024 * 1024, movable: 1 });
    await expect(moves.latest(context, principal('member'))).rejects.toMatchObject({
      status: 403,
    });
  });

  it('answers 404 for a job id that is not a uuid of this workspace', async () => {
    const { moves } = service();
    await expect(moves.status(context, principal('owner'), 'not-an-id')).rejects.toMatchObject({
      status: 404,
    });
  });
});
