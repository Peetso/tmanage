import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  escapeCsvCell,
  exportObjectKey,
  exportWriterFor,
  filesystemExportWriter,
  privateObjectPath,
  runExportJobs,
  toCsv,
} from './export-jobs.js';
import type {
  ClaimedExportJob,
  ExportJobStore,
  ExportObjectWriter,
  ExportTable,
  RemovableExport,
} from './export-jobs.js';
import { EXPORT_SCOPE_QUERIES } from '../common/database/export-jobs-store.js';

/** platform-admin v2 · PA-09 — the CSV export job (SPEC §4 C6). */

interface FakeState {
  queue: ClaimedExportJob[];
  rows: ExportTable;
  ready: { id: string; rowCount: number; objectKey: string }[];
  failed: { id: string; error: string }[];
  removable: RemovableExport[];
  removed: RemovableExport[];
  deletedMeanwhile: Set<string>;
}

function fakeStore(state: FakeState): ExportJobStore {
  return {
    claimNext: () => Promise.resolve(state.queue.shift() ?? null),
    readRows: () => Promise.resolve(state.rows),
    finishReady: (id, rowCount, objectKey) => {
      if (state.deletedMeanwhile.has(id)) return Promise.resolve(false);
      state.ready.push({ id, rowCount, objectKey });
      return Promise.resolve(true);
    },
    finishFailed: (id, error) => {
      state.failed.push({ id, error });
      return Promise.resolve();
    },
    listRemovable: () => Promise.resolve(state.removable),
    markRemoved: (file) => {
      state.removed.push(file);
      return Promise.resolve();
    },
    failStale: () => Promise.resolve(0),
  };
}

function memoryWriter(): ExportObjectWriter & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    put: (key, bytes) => {
      files.set(key, bytes.toString('utf8'));
      return Promise.resolve();
    },
    remove: (key) => {
      files.delete(key);
      return Promise.resolve();
    },
  };
}

function state(overrides: Partial<FakeState> = {}): FakeState {
  return {
    queue: [],
    rows: { header: ['a'], rows: [] },
    ready: [],
    failed: [],
    removable: [],
    removed: [],
    deletedMeanwhile: new Set(),
    ...overrides,
  };
}

const JOB: ClaimedExportJob = { id: 'job-1', scope: 'actions', filter: {} };

describe('CSV', () => {
  it('guards formulas and quotes like the action log export', () => {
    expect(escapeCsvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(escapeCsvCell('-1,2')).toBe(`"'-1,2"`);
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell('plain')).toBe('plain');
    expect(toCsv({ header: ['A', 'B'], rows: [['1', null]] })).toBe('A,B\r\n1,\r\n');
  });
});

describe('runExportJobs', () => {
  it('writes a ready file for a queued job', async () => {
    const s = state({ queue: [JOB], rows: { header: ['Action'], rows: [['task.created']] } });
    const writer = memoryWriter();
    const result = await runExportJobs(fakeStore(s), writer);
    expect(result).toMatchObject({ written: 1, failed: 0 });
    expect(s.ready).toHaveLength(1);
    const key = s.ready[0]?.objectKey ?? '';
    expect(key).toMatch(/^platform\/exports\/job-1\/[0-9a-f]{32}\.csv$/u);
    expect(writer.files.get(key)).toBe('Action\r\ntask.created\r\n');
  });

  it('fails a job over the row cap with a message to narrow the filter', async () => {
    const s = state({
      queue: [JOB],
      rows: { header: ['x'], rows: [['1'], ['2'], ['3']] },
    });
    const writer = memoryWriter();
    await runExportJobs(fakeStore(s), writer, { cap: 2 });
    expect(s.failed).toEqual([{ id: 'job-1', error: 'Over 2 rows. Narrow the filter.' }]);
    expect(writer.files.size).toBe(0);
  });

  it('fails plainly when no file storage is set up', async () => {
    const s = state({ queue: [JOB] });
    await runExportJobs(fakeStore(s), null);
    expect(s.failed[0]?.error).toBe('No file storage is set up for exports.');
  });

  it('removes the file when the job was deleted while it ran', async () => {
    const s = state({ queue: [JOB], deletedMeanwhile: new Set(['job-1']) });
    const writer = memoryWriter();
    const result = await runExportJobs(fakeStore(s), writer);
    expect(result.written).toBe(0);
    expect(writer.files.size).toBe(0);
  });

  it('removes expired and deleted files before claiming', async () => {
    const writer = memoryWriter();
    writer.files.set('platform/exports/a/x.csv', 'old');
    const s = state({
      removable: [{ id: 'a', objectKey: 'platform/exports/a/x.csv', kind: 'expire' }],
    });
    const result = await runExportJobs(fakeStore(s), writer);
    expect(result.removed).toBe(1);
    expect(writer.files.size).toBe(0);
    expect(s.removed).toHaveLength(1);
  });
});

describe('file layout', () => {
  let root = '';
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('writes under <root>/objects/private/<key>, the API store layout', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'tm-exports-'));
    const writer = filesystemExportWriter(root);
    const key = exportObjectKey('0190a3b4-0000-7000-8000-000000000001');
    await writer.put(key, Buffer.from('a,b\r\n'));
    const target = path.join(root, 'objects', 'private', ...key.split('/'));
    expect(await readFile(target, 'utf8')).toBe('a,b\r\n');
    await writer.remove(key);
    await expect(stat(target)).rejects.toThrow();
  });

  it('refuses a key that climbs out of the zone', () => {
    expect(() => privateObjectPath('/srv', '../etc/passwd')).toThrow('unsafe export object key');
    expect(() => privateObjectPath('/srv', 'platform//x')).toThrow('unsafe export object key');
  });

  it('picks the writer for the storage driver', () => {
    expect(exportWriterFor({ STORAGE_DRIVER: 's3', STORAGE_FILESYSTEM_ROOT: '.local' })).toBeNull();
    expect(
      exportWriterFor({ STORAGE_DRIVER: 'filesystem', STORAGE_FILESYSTEM_ROOT: '.local' }),
    ).not.toBeNull();
  });
});

describe('scope queries', () => {
  it('never reads metadata, changes or token hashes', () => {
    for (const query of Object.values(EXPORT_SCOPE_QUERIES)) {
      const built = query.build({});
      const sql = built.sql('?');
      expect(sql).not.toMatch(
        /metadata_json|audit_event_changes|token_hash|authentication_events/u,
      );
      expect(query.header).toHaveLength(query.columns.length);
    }
  });

  it('binds every filter value as a parameter', () => {
    const built = EXPORT_SCOPE_QUERIES.actions.build({
      organizationId: 'org-1',
      action: "x' or 1=1",
      supportOnly: 'true',
      from: '2026-10-01T00:00:00.000Z',
    });
    const sql = built.sql('?');
    expect(sql).toContain('e.organization_id = ?');
    expect(sql).toContain('e.platform_support_session_id IS NOT NULL');
    expect(sql).not.toContain('1=1');
    expect(built.params).toEqual(['org-1', "x' or 1=1", new Date('2026-10-01T00:00:00.000Z')]);
  });

  it('defaults the sessions export to active sessions', () => {
    expect(EXPORT_SCOPE_QUERIES.sessions.build({}).sql('?')).toContain('s.revoked_at IS NULL');
    expect(EXPORT_SCOPE_QUERIES.sessions.build({ active: 'false' }).sql('?')).not.toContain(
      's.revoked_at IS NULL',
    );
  });
});
