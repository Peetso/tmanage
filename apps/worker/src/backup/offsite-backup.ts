/**
 * OFFSITE-BACKUP. The daily off-site backup of the database to OCI Object Storage (Always Free),
 * run inside the app as one of the scheduled jobs (`jobs/scheduled-jobs.ts`), so it uses the
 * app's own settings, its sweep lock (one process runs it, AS-4 / RT-3) and its logs, and needs
 * no cron entry, no shell and no client binary on the host.
 *
 * One pass (IP-17: one bounded pass, the schedule checked inside it against database state):
 *
 * 1. due? the last OCI run that succeeded is ≥ 23 h 45 min old, and the last attempt (ok or
 *    not) is ≥ 1 h old, so a failing setup retries hourly, not every tick;
 * 2. dump inside one consistent snapshot (`common/database/backup-store.ts`) → gzip → age
 *    (public key only) → a 0600 file in a private temp directory; the plaintext is never written;
 * 3. SHA-256 and MD5 of the ciphertext while it is written; the manifest (the format
 *    `scripts/ops/restore.mjs` reads) records the ciphertext SHA-256, the gzip SHA-256, the
 *    ledger versions and the row counts;
 * 4. upload the dump, then the manifest (the commit point), each with its SHA-256 signed into
 *    the request (`x-amz-content-sha256`) and its `Content-MD5`; then **read each one back and
 *    hash it**: a mismatch deletes the object and fails the run;
 * 5. retention (`retention.ts`: 7 daily + 4 weekly, inside the byte budget), deleting only
 *    after the new backup is verified, unless the budget needs room first;
 * 6. a `platform_backup_runs` row, ok or failed, which `/healthz/deep` reads.
 *
 * A failure is recorded, then rethrown, so both hosts log it (`sweep offsite-backup failed: …`);
 * the scheduler catches it, and the app keeps serving. Nothing here calls `process.exit`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import { dumpDatabase } from '../common/database/backup-dump.js';
import type { DumpCounts } from '../common/database/backup-dump.js';
import { openBackupSession } from '../common/database/backup-store.js';
import type {
  BackupRunRecord,
  BackupSession,
  OffsiteRunTimes,
} from '../common/database/backup-store.js';
import { encryptStream } from './age.js';
import { parseBackupConfig } from './backup-config.js';
import type { OffsiteBackupConfig, OffsiteBackupEnv, ParsedBackupConfig } from './backup-config.js';
import { OciObjectStore } from './oci-object-store.js';
import type { LocalFile, ObjectDigest, StoredObject } from './oci-object-store.js';
import { isStamp, planRetention, stampOf } from './retention.js';
import type { OffsiteBackup } from './retention.js';

export const OFFSITE_BACKUP_JOB = 'offsite-backup';
/** The scheduler's tick; the pass itself decides whether a backup is due. */
export const OFFSITE_BACKUP_TICK_MS = 15 * 60_000;
/** A backup is due once the last good one is this old (one day less one tick). */
export const OFFSITE_BACKUP_EVERY_MS = 24 * 3_600_000 - OFFSITE_BACKUP_TICK_MS;
/** After any attempt, the next one waits at least this long. */
export const OFFSITE_RETRY_AFTER_MS = 3_600_000;
/** Object keys live under this prefix: `db/<stamp>/db.sql.gz.age`, `db/<stamp>/manifest.json`. */
export const OFFSITE_PREFIX = 'db/';
export const DUMP_OBJECT = 'db.sql.gz.age';
export const MANIFEST_OBJECT = 'manifest.json';
/** `scripts/ops/backup-plan.mjs` MANIFEST_FORMAT: restore.mjs reads this manifest unchanged. */
export const MANIFEST_FORMAT = 1;

export function offsiteBackupDue(times: OffsiteRunTimes, now: Date): boolean {
  const t = now.getTime();
  if (times.lastAttemptAt !== null && t - times.lastAttemptAt.getTime() < OFFSITE_RETRY_AFTER_MS) {
    return false;
  }
  return (
    times.lastSuccessAt === null || t - times.lastSuccessAt.getTime() >= OFFSITE_BACKUP_EVERY_MS
  );
}

/** The object store operations the pass uses (`OciObjectStore`, or a fake in tests). */
export interface OffsiteStore {
  location(key: string): string;
  putObject(key: string, file: LocalFile, contentType: string): Promise<void>;
  digestObject(key: string): Promise<ObjectDigest>;
  deleteObject(key: string): Promise<void>;
  listObjects(prefix: string): Promise<readonly StoredObject[]>;
}

export interface OffsitePassDeps {
  readonly parsed: ParsedBackupConfig;
  readonly openSession: () => Promise<BackupSession>;
  readonly store: (config: OffsiteBackupConfig) => OffsiteStore;
  readonly now?: () => Date;
  readonly tempRoot?: string;
  readonly log?: (line: string) => void;
}

interface FileDigest {
  bytes: number;
  sha256: string;
  md5Base64: string;
}

/** A pass-through that hashes what flows through it. */
function digesting(into: FileDigest, md5 = false): Transform {
  const sha = createHash('sha256');
  const md = md5 ? createHash('md5') : null;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      into.bytes += chunk.length;
      sha.update(chunk);
      md?.update(chunk);
      done(null, chunk);
    },
    flush(done) {
      into.sha256 = sha.digest('hex');
      into.md5Base64 = md?.digest('base64') ?? '';
      done();
    },
  });
}

const emptyDigest = (): FileDigest => ({ bytes: 0, sha256: '', md5Base64: '' });

/** Stamps under the prefix, with their total size and whether the manifest (commit point) is there. */
export function groupOffsiteObjects(objects: readonly StoredObject[]): {
  readonly backups: readonly OffsiteBackup[];
  readonly keysByStamp: ReadonlyMap<string, readonly string[]>;
} {
  const keys = new Map<string, string[]>();
  const bytes = new Map<string, number>();
  const complete = new Set<string>();
  for (const o of objects) {
    if (!o.key.startsWith(OFFSITE_PREFIX)) continue;
    const [stamp, name, ...rest] = o.key.slice(OFFSITE_PREFIX.length).split('/');
    if (stamp === undefined || name === undefined || rest.length > 0 || !isStamp(stamp)) continue;
    keys.set(stamp, [...(keys.get(stamp) ?? []), o.key]);
    bytes.set(stamp, (bytes.get(stamp) ?? 0) + o.size);
    if (name === MANIFEST_OBJECT) complete.add(stamp);
  }
  return {
    backups: [...keys.keys()].map((stamp) => ({
      stamp,
      bytes: bytes.get(stamp) ?? 0,
      complete: complete.has(stamp),
    })),
    keysByStamp: keys,
  };
}

/** Upload, read back, compare; a mismatch removes the object and throws. */
async function uploadVerified(
  store: OffsiteStore,
  key: string,
  file: LocalFile,
  contentType: string,
): Promise<void> {
  await store.putObject(key, file, contentType);
  const stored = await store.digestObject(key);
  if (stored.bytes !== file.bytes || stored.sha256 !== file.sha256) {
    await store.deleteObject(key).catch(() => undefined);
    throw new Error(
      `verification failed for ${key}: stored ${String(stored.bytes)} bytes sha256 ${stored.sha256}, sent ${String(file.bytes)} bytes sha256 ${file.sha256}`,
    );
  }
}

async function deleteStamps(
  store: OffsiteStore,
  stamps: readonly string[],
  keysByStamp: ReadonlyMap<string, readonly string[]>,
): Promise<number> {
  let deleted = 0;
  for (const stamp of stamps) {
    // The manifest goes first, so a half-deleted backup reads as incomplete, never as whole.
    const keys = [...(keysByStamp.get(stamp) ?? [])].sort((a, b) =>
      a.endsWith(MANIFEST_OBJECT) ? -1 : b.endsWith(MANIFEST_OBJECT) ? 1 : 0,
    );
    for (const key of keys) await store.deleteObject(key);
    deleted += 1;
  }
  return deleted;
}

const oneLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, ' ').slice(0, 480);

/** One pass of the job. Resolves the line to log, or `null` when nothing was due. */
export async function runOffsiteBackupPass(deps: OffsitePassDeps): Promise<string | null> {
  const { parsed } = deps;
  if (parsed.status === 'off') return null;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.warn(line));

  const session = await deps.openSession();
  let snapshotOpen = false;
  let workDir: string | null = null;
  const startedAt = now();
  const stamp = stampOf(startedAt);
  const bucket =
    parsed.status === 'ready' ? parsed.config.bucket : (parsed.bucket ?? 'unconfigured');
  const prefix = `${OFFSITE_PREFIX}${stamp}/`;
  const run: {
    -readonly [K in keyof BackupRunRecord]: BackupRunRecord[K];
  } = {
    id: randomUUID(),
    kind: 'scheduled',
    frequencyKind: 'daily',
    stamp,
    startedAt,
    finishedAt: startedAt,
    status: 'failed',
    dbBytes: null,
    manifestSha: null,
    gitSha: null,
    offsiteStatus: 'failed',
    offsiteLocation: `oci:${bucket}/${prefix}`,
    offsiteAt: null,
    error: null,
  };
  try {
    if (!offsiteBackupDue(await session.offsiteRunTimes(), startedAt)) return null;
    if (parsed.status === 'invalid') {
      throw new Error(`off-site backup is misconfigured: ${parsed.problems.join('; ')}`);
    }
    const { config } = parsed;
    const store = deps.store(config);
    run.offsiteLocation = store.location(prefix);

    workDir = await mkdtemp(join(deps.tempRoot ?? tmpdir(), 'tmanage-backup-'));
    const dumpPath = join(workDir, DUMP_OBJECT);
    const counts: DumpCounts = {
      tables: 0,
      rows: 0,
      views: 0,
      routines: 0,
      events: 0,
      triggers: 0,
    };
    const gz = emptyDigest();
    const sealed = emptyDigest();

    const source = await session.beginSnapshot();
    snapshotOpen = true;
    const migrations = await session.appliedMigrations();
    await pipeline(
      Readable.from(dumpDatabase(source, counts, { now: startedAt })),
      createGzip({ level: 6 }),
      digesting(gz),
      encryptStream(config.recipients),
      digesting(sealed, true),
      createWriteStream(dumpPath, { mode: 0o600 }),
    );
    await session.endSnapshot();
    snapshotOpen = false;

    const manifest = {
      format: MANIFEST_FORMAT,
      stamp,
      createdAt: startedAt.toISOString(),
      gitSha: null,
      database: session.database,
      engine: source.serverVersion,
      tool: 'apps/worker offsite-backup (logical dump)',
      migrations: {
        count: migrations.length,
        latest: migrations.at(-1) ?? null,
        versions: migrations,
      },
      counts,
      files: {
        db: {
          name: DUMP_OBJECT,
          bytes: sealed.bytes,
          sha256: sealed.sha256,
          plainSha256: gz.sha256,
          encrypted: 'age',
        },
      },
    };
    const manifestPath = join(workDir, MANIFEST_OBJECT);
    const manifestBody = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await writeFile(manifestPath, manifestBody, { mode: 0o600 });
    const manifestFile: LocalFile = {
      path: manifestPath,
      bytes: manifestBody.length,
      sha256: createHash('sha256').update(manifestBody).digest('hex'),
      md5Base64: createHash('md5').update(manifestBody).digest('base64'),
    };
    const dumpFile: LocalFile = {
      path: dumpPath,
      bytes: (await stat(dumpPath)).size,
      sha256: sealed.sha256,
      md5Base64: sealed.md5Base64,
    };
    if (dumpFile.bytes !== sealed.bytes)
      throw new Error('dump file size differs from what was written');
    const newBytes = dumpFile.bytes + manifestFile.bytes;
    if (newBytes > config.maxBytes) {
      throw new Error(
        `backup is ${String(newBytes)} bytes, over the ${String(config.maxBytes)}-byte budget`,
      );
    }

    const existing = groupOffsiteObjects(await store.listObjects(OFFSITE_PREFIX));
    const plan = planRetention(
      [
        ...existing.backups.filter((b) => b.stamp !== stamp),
        { stamp, bytes: newBytes, complete: true },
      ],
      startedAt,
      config.maxBytes,
    );
    const existingBytes = existing.backups.reduce((sum, b) => sum + b.bytes, 0);
    let pruned = 0;
    let pending = plan.remove;
    if (existingBytes + newBytes > config.maxBytes) {
      // Room first: these go anyway, and the upload must not push the bucket past the budget.
      pruned += await deleteStamps(store, pending, existing.keysByStamp);
      pending = [];
    }

    await uploadVerified(store, `${prefix}${DUMP_OBJECT}`, dumpFile, 'application/octet-stream');
    await uploadVerified(store, `${prefix}${MANIFEST_OBJECT}`, manifestFile, 'application/json');
    run.offsiteAt = now();

    try {
      pruned += await deleteStamps(store, pending, existing.keysByStamp);
    } catch (error) {
      // The new backup is safe; the next pass retries the pruning.
      log(`[worker] ${OFFSITE_BACKUP_JOB}: retention cleanup failed: ${oneLine(error)}`);
    }

    run.status = 'ok';
    run.offsiteStatus = 'uploaded';
    run.dbBytes = dumpFile.bytes;
    run.manifestSha = manifestFile.sha256;
    return `${stamp}: ${String(counts.tables)} table(s), ${String(counts.rows)} row(s), ${String(counts.triggers)} trigger(s), ${String(dumpFile.bytes)} bytes encrypted, verified at ${run.offsiteLocation}; kept ${String(plan.keep.length)}, pruned ${String(pruned)}`;
  } catch (error) {
    run.error = oneLine(error);
    throw error;
  } finally {
    if (workDir !== null)
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    // A pass that failed inside the snapshot may have left a half-read result on the connection;
    // that connection is dropped (the server rolls the snapshot back) and a fresh one records.
    let recorder: BackupSession | null = session;
    if (snapshotOpen) {
      await session.close().catch(() => undefined);
      recorder = null;
    }
    // Only a pass that got past the due check leaves a row; the early `return null` does not.
    if (run.status === 'ok' || run.error !== null) {
      run.finishedAt = now();
      try {
        recorder ??= await deps.openSession();
        await recorder.recordRun(run);
      } catch (error) {
        log(`[worker] ${OFFSITE_BACKUP_JOB}: could not record the run: ${oneLine(error)}`);
      }
    }
    await recorder?.close().catch(() => undefined);
  }
}

/** The scheduled job: settings parsed once at boot, one pass per tick. */
export function createOffsiteBackupJob(env: OffsiteBackupEnv): {
  readonly name: string;
  readonly intervalMs: number;
  run(): Promise<string | null>;
} {
  const parsed = parseBackupConfig(env);
  if (parsed.status === 'invalid') {
    console.warn(
      `[worker] ${OFFSITE_BACKUP_JOB}: misconfigured, no off-site copy will be made: ${parsed.problems.join('; ')}`,
    );
  }
  return {
    name: OFFSITE_BACKUP_JOB,
    intervalMs: OFFSITE_BACKUP_TICK_MS,
    run: () =>
      runOffsiteBackupPass({
        parsed,
        openSession: () => openBackupSession(env.DATABASE_MIGRATION_URL ?? ''),
        store: (config) =>
          new OciObjectStore({
            endpoint: config.endpoint,
            region: config.region,
            bucket: config.bucket,
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }),
      }),
  };
}
