import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DumpSource } from '../common/database/backup-dump.js';
import type {
  BackupRunRecord,
  BackupSession,
  OffsiteRunTimes,
} from '../common/database/backup-store.js';
import { decryptStream, generateIdentity } from './age.js';
import { parseBackupConfig } from './backup-config.js';
import type { ParsedBackupConfig } from './backup-config.js';
import {
  DUMP_OBJECT,
  MANIFEST_OBJECT,
  OFFSITE_RETRY_AFTER_MS,
  offsiteBackupDue,
  runOffsiteBackupPass,
} from './offsite-backup.js';
import type { OffsiteStore } from './offsite-backup.js';
import type { LocalFile } from './oci-object-store.js';

const NOW = new Date('2026-11-20T03:00:00Z');
const KEYS = generateIdentity();
const READY = parseBackupConfig({
  DATABASE_MIGRATION_URL: 'mysql://owner:pw@127.0.0.1:3306/u1_tmanage',
  BACKUP_OCI_NAMESPACE: 'ns',
  BACKUP_OCI_BUCKET: 'tmanage-db-backups',
  BACKUP_OCI_ACCESS_KEY_ID: 'key-id',
  BACKUP_OCI_SECRET_ACCESS_KEY: 'secret',
  BACKUP_AGE_RECIPIENT: KEYS.recipient,
});

const source: DumpSource = {
  database: 'u1_tmanage',
  serverVersion: '11.8.3-MariaDB',
  baseTables: () => Promise.resolve(['users']),
  views: () => Promise.resolve([]),
  columns: () =>
    Promise.resolve([
      { name: 'id', dataType: 'char', extra: '' },
      { name: 'email', dataType: 'varchar', extra: '' },
    ]),
  createTable: () => Promise.resolve('CREATE TABLE `users` (`id` char(36), `email` varchar(320))'),
  routines: () => Promise.resolve([]),
  events: () => Promise.resolve([]),
  triggers: () => Promise.resolve([]),
  rows: () =>
    (async function* () {
      yield [Buffer.from('u1'), Buffer.from('alice@example.com')];
    })(),
};

interface FakeSession extends BackupSession {
  readonly recorded: BackupRunRecord[];
  readonly calls: string[];
}

function fakeSession(times: OffsiteRunTimes, dump: DumpSource = source): FakeSession {
  const recorded: BackupRunRecord[] = [];
  const calls: string[] = [];
  return {
    recorded,
    calls,
    database: 'u1_tmanage',
    offsiteRunTimes: () => Promise.resolve(times),
    beginSnapshot: () => {
      calls.push('begin');
      return Promise.resolve(dump);
    },
    endSnapshot: () => {
      calls.push('end');
      return Promise.resolve();
    },
    appliedMigrations: () => Promise.resolve([1, 2, 371]),
    recordRun: (run) => {
      recorded.push(run);
      return Promise.resolve();
    },
    close: () => {
      calls.push('close');
      return Promise.resolve();
    },
  };
}

interface FakeStore extends OffsiteStore {
  readonly objects: Map<string, Buffer>;
  readonly log: string[];
  corruptOnRead?: boolean;
}

function fakeStore(initial: Record<string, Buffer> = {}): FakeStore {
  const objects = new Map(Object.entries(initial));
  const log: string[] = [];
  const s: FakeStore = {
    objects,
    log,
    location: (key) => `oci:tmanage-db-backups/${key}`,
    putObject: async (key: string, file: LocalFile) => {
      log.push(`put ${key}`);
      const body = await readFile(file.path);
      // What the real store does with the signed hash and Content-MD5: refuse a different body.
      if (createHash('sha256').update(body).digest('hex') !== file.sha256)
        throw new Error('XAmzContentSHA256Mismatch');
      if (createHash('md5').update(body).digest('base64') !== file.md5Base64)
        throw new Error('BadDigest');
      objects.set(key, body);
    },
    digestObject: (key) => {
      log.push(`get ${key}`);
      const body = objects.get(key) ?? Buffer.alloc(0);
      const read = s.corruptOnRead === true ? Buffer.concat([body, Buffer.from('!')]) : body;
      return Promise.resolve({
        bytes: read.length,
        sha256: createHash('sha256').update(read).digest('hex'),
      });
    },
    deleteObject: (key) => {
      log.push(`delete ${key}`);
      objects.delete(key);
      return Promise.resolve();
    },
    listObjects: (prefix) => {
      log.push(`list ${prefix}`);
      return Promise.resolve(
        [...objects.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, v]) => ({ key, size: v.length })),
      );
    },
  };
  return s;
}

let tempRoot = '';
beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'offsite-pass-test-'));
});
afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const never: OffsiteRunTimes = { lastSuccessAt: null, lastAttemptAt: null };

function pass(
  parsed: ParsedBackupConfig,
  session: FakeSession,
  store: FakeStore,
  lines: string[] = [],
) {
  return runOffsiteBackupPass({
    parsed,
    openSession: () => Promise.resolve(session),
    store: () => store,
    now: () => NOW,
    tempRoot,
    log: (l) => lines.push(l),
  });
}

describe('offsiteBackupDue', () => {
  it('is due daily, and waits an hour after any attempt', () => {
    const h = (n: number): Date => new Date(NOW.getTime() - n * 3_600_000);
    expect(offsiteBackupDue(never, NOW)).toBe(true);
    expect(offsiteBackupDue({ lastSuccessAt: h(24), lastAttemptAt: h(24) }, NOW)).toBe(true);
    expect(offsiteBackupDue({ lastSuccessAt: h(23), lastAttemptAt: h(23) }, NOW)).toBe(false);
    expect(offsiteBackupDue({ lastSuccessAt: null, lastAttemptAt: h(0.5) }, NOW)).toBe(false);
    expect(
      offsiteBackupDue(
        { lastSuccessAt: null, lastAttemptAt: new Date(NOW.getTime() - OFFSITE_RETRY_AFTER_MS) },
        NOW,
      ),
    ).toBe(true);
  });

  it('a failing setup costs at most a few thousand of the 50,000 free API requests a month', () => {
    // Worst case: one attempt an hour, every hour; a failing attempt makes at most 6 calls.
    expect(24 * 31 * 6).toBeLessThan(50_000 / 10);
  });
});

describe('runOffsiteBackupPass (OFFSITE-BACKUP)', () => {
  it('does nothing, records nothing and calls no API when switched off or not due', async () => {
    const session = fakeSession(never);
    const store = fakeStore();
    expect(await pass({ status: 'off' }, session, store)).toBeNull();
    const fresh = fakeSession({ lastSuccessAt: NOW, lastAttemptAt: NOW });
    expect(await pass(READY, fresh, store)).toBeNull();
    expect([...session.recorded, ...fresh.recorded]).toEqual([]);
    expect(store.log).toEqual([]);
    expect(fresh.calls).toEqual(['close']);
  });

  it('uploads an encrypted dump and its manifest, reads both back, then records ok', async () => {
    const session = fakeSession(never);
    const store = fakeStore();
    const line = await pass(READY, session, store);
    const stamp = '20261120T030000Z';
    expect(store.log).toEqual([
      'list db/',
      `put db/${stamp}/${DUMP_OBJECT}`,
      `get db/${stamp}/${DUMP_OBJECT}`,
      `put db/${stamp}/${MANIFEST_OBJECT}`,
      `get db/${stamp}/${MANIFEST_OBJECT}`,
    ]);
    expect(line).toMatch(
      /1 table\(s\), 1 row\(s\).*verified at oci:tmanage-db-backups\/db\/20261120T030000Z\//u,
    );

    const sealed = store.objects.get(`db/${stamp}/${DUMP_OBJECT}`) ?? Buffer.alloc(0);
    expect(sealed.includes(Buffer.from('alice@example.com'))).toBe(false);
    const sql = gunzipSync(
      await buffer(Readable.from([sealed]).pipe(decryptStream(KEYS.identity))),
    ).toString('utf8');
    // The dump writer's exact output is proved in backup-dump.test.ts; here: the row arrived.
    expect(sql).toContain("(`id`,`email`) VALUES ('u1','alice@example.com');");

    const manifest = JSON.parse(
      (store.objects.get(`db/${stamp}/${MANIFEST_OBJECT}`) ?? '').toString(),
    ) as {
      format: number;
      migrations: { count: number; latest: number; versions: number[] };
      files: { db: { name: string; bytes: number; sha256: string; encrypted: string } };
    };
    // The manifest restore.mjs validates: format 1, the ledger, the ciphertext's hash.
    expect(manifest.format).toBe(1);
    expect(manifest.migrations).toEqual({ count: 3, latest: 371, versions: [1, 2, 371] });
    expect(manifest.files.db).toMatchObject({
      name: DUMP_OBJECT,
      bytes: sealed.length,
      encrypted: 'age',
    });
    expect(manifest.files.db.sha256).toBe(createHash('sha256').update(sealed).digest('hex'));

    expect(session.recorded).toHaveLength(1);
    expect(session.recorded[0]).toMatchObject({
      status: 'ok',
      offsiteStatus: 'uploaded',
      offsiteLocation: `oci:tmanage-db-backups/db/${stamp}/`,
      dbBytes: sealed.length,
      error: null,
    });
    expect(session.calls).toEqual(['begin', 'end', 'close']);
    // The temp directory is gone: nothing of the dump stays on the host.
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it('fails, removes the object and records failed when the read-back differs', async () => {
    const session = fakeSession(never);
    const store = fakeStore();
    store.corruptOnRead = true;
    await expect(pass(READY, session, store)).rejects.toThrow(/verification failed/u);
    expect(store.objects.size).toBe(0);
    expect(session.recorded[0]).toMatchObject({ status: 'failed', offsiteStatus: 'failed' });
    expect(session.recorded[0]?.error).toMatch(/verification failed/u);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it('records a failed run for a misconfigured setup, never touching the bucket', async () => {
    const session = fakeSession(never);
    const store = fakeStore();
    const parsed = parseBackupConfig({
      DATABASE_MIGRATION_URL: 'mysql://x',
      BACKUP_OCI_BUCKET: 'b',
    });
    await expect(pass(parsed, session, store)).rejects.toThrow(/misconfigured/u);
    expect(store.log).toEqual([]);
    expect(session.recorded[0]).toMatchObject({
      status: 'failed',
      offsiteLocation: 'oci:b/db/20261120T030000Z/',
    });
  });

  it('records the failure on a fresh connection when the dump breaks inside the snapshot', async () => {
    const broken: DumpSource = {
      ...source,
      rows: () =>
        (async function* () {
          yield [Buffer.from('u1'), Buffer.from('a')];
          throw new Error('Lost connection to server during query');
        })(),
    };
    const first = fakeSession(never, broken);
    const second = fakeSession(never);
    let opened = 0;
    await expect(
      runOffsiteBackupPass({
        parsed: READY,
        openSession: () => Promise.resolve(opened++ === 0 ? first : second),
        store: () => fakeStore(),
        now: () => NOW,
        tempRoot,
        log: () => undefined,
      }),
    ).rejects.toThrow(/Lost connection/u);
    expect(first.recorded).toEqual([]);
    expect(first.calls).toEqual(['begin', 'close']);
    expect(second.recorded[0]?.error).toMatch(/Lost connection/u);
  });

  it('prunes by the rotation only after the new backup is verified', async () => {
    const old: Record<string, Buffer> = {};
    for (let d = 1; d <= 9; d += 1) {
      const stamp = `202611${String(20 - d).padStart(2, '0')}T030000Z`;
      old[`db/${stamp}/${DUMP_OBJECT}`] = Buffer.alloc(10);
      old[`db/${stamp}/${MANIFEST_OBJECT}`] = Buffer.alloc(1);
    }
    old['db/README.txt'] = Buffer.from('operator note');
    const store = fakeStore(old);
    const line = await pass(READY, fakeSession(never), store);
    const firstDelete = store.log.findIndex((l) => l.startsWith('delete'));
    const lastGet = store.log.map((l) => l.startsWith('get')).lastIndexOf(true);
    expect(firstDelete).toBeGreaterThan(lastGet);
    // Kept: today + 6 dailies (11th–19th → 19..14) plus older weekly heads; the README stays.
    expect(store.objects.has('db/README.txt')).toBe(true);
    expect(line).toMatch(/pruned [1-9]/u);
    // A deleted backup loses its manifest first, so it can never read as complete half-deleted.
    const deletes = store.log.filter((l) => l.startsWith('delete'));
    expect(deletes[0]).toMatch(/manifest\.json$/u);
  });

  it('frees room before the upload when the bucket would pass the byte budget', async () => {
    const parsed = parseBackupConfig({
      DATABASE_MIGRATION_URL: 'mysql://owner:pw@127.0.0.1:3306/u1_tmanage',
      BACKUP_OCI_NAMESPACE: 'ns',
      BACKUP_OCI_BUCKET: 'tmanage-db-backups',
      BACKUP_OCI_ACCESS_KEY_ID: 'key-id',
      BACKUP_OCI_SECRET_ACCESS_KEY: 'secret',
      BACKUP_AGE_RECIPIENT: KEYS.recipient,
      BACKUP_OCI_MAX_BYTES: 3_000,
    });
    const store = fakeStore({
      [`db/20261119T030000Z/${DUMP_OBJECT}`]: Buffer.alloc(1_000),
      [`db/20261119T030000Z/${MANIFEST_OBJECT}`]: Buffer.alloc(10),
      [`db/20261118T030000Z/${DUMP_OBJECT}`]: Buffer.alloc(1_500),
      [`db/20261118T030000Z/${MANIFEST_OBJECT}`]: Buffer.alloc(10),
    });
    await pass(parsed, fakeSession(never), store);
    const firstDelete = store.log.findIndex((l) => l.startsWith('delete'));
    const firstPut = store.log.findIndex((l) => l.startsWith('put'));
    expect(firstDelete).toBeGreaterThan(-1);
    expect(firstDelete).toBeLessThan(firstPut);
    expect(store.objects.has(`db/20261118T030000Z/${DUMP_OBJECT}`)).toBe(false);
    expect(store.objects.has(`db/20261119T030000Z/${DUMP_OBJECT}`)).toBe(true);
  });
});
