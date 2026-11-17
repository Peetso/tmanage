import { describe, expect, it } from 'vitest';
import {
  isRotationPurpose,
  runKeyRotation,
  ROTATION_TARGETS,
  type RotationStore,
  type SecretRow,
} from './field-cipher-rotation.js';

const rows: SecretRow[] = Array.from({ length: 501 }, (_, i) => ({
  id: String(i).padStart(4, '0'),
  ownerId: String(i),
  value: i === 0 ? 'mfa1.legacy' : 'fc1.old',
}));
const cipher = {
  activeKeyId: () => '2',
  isEnvelope: (v: string) => v.startsWith('fc1.'),
  rotate: (v: string) => (v === 'fc1.old' ? 'fc1.new' : null),
};
function store(lastRowId: string | null, toKeyId = '2', purpose = 'storage_token') {
  const calls: string[] = [];
  const s: RotationStore = {
    claimNext: async () => ({
      id: 'r',
      purpose,
      toKeyId,
      lastRowId,
      counts: { done: 0, skipped: 0, failed: 0 },
    }),
    countTotal: async () => void calls.push('count'),
    readBatch: async (_t, after, limit) => rows.filter((r) => r.id > (after ?? '')).slice(0, limit),
    writeValue: async (_t, id) => (calls.push(`w${id}`), true),
    saveProgress: async (_id, last) => void calls.push(`save${last}`),
    finish: async (_id, status) => void calls.push(status),
    pause: async () => void calls.push('pause'),
  };
  return { s, calls };
}

describe('key rotation job (56-02)', () => {
  it('re-encrypts in 500-row batches, skips legacy values, and pauses resumably', async () => {
    const { s, calls } = store(null);
    const result = await runKeyRotation({ store: s, cipher, maxBatches: 1 });
    expect(result).toMatchObject({ status: 'paused', counts: { done: 499, skipped: 1 } });
    expect(calls).toContain('save0499');
    expect(calls.at(-1)).toBe('pause');
  });

  it('resumes after the saved row and finishes', async () => {
    const { s, calls } = store('0499');
    const result = await runKeyRotation({ store: s, cipher });
    expect(result).toMatchObject({ status: 'done', counts: { done: 1 } });
    expect(calls).not.toContain('count');
  });

  it('refuses when the target key is not the newest in env', async () => {
    const { s, calls } = store(null, '3');
    expect((await runKeyRotation({ store: s, cipher })).status).toBe('failed');
    expect(calls.some((c) => c.startsWith('w'))).toBe(false);
  });

  it('walks security_reports.reporter_email_enc with the writer AAD (56-17 follow-up)', async () => {
    expect(isRotationPurpose('reporter_email')).toBe(true);
    const { s } = store('0497', '2', 'reporter_email');
    const tables: string[] = [];
    const read = s.readBatch;
    s.readBatch = async (t, after, limit) => (
      tables.push(`${t.table}.${t.column}`),
      read(t, after, limit)
    );
    const aads: unknown[] = [];
    const rotate = (v: string, aad: unknown) => (aads.push(aad), cipher.rotate(v));
    await runKeyRotation({ store: s, cipher: { ...cipher, rotate } });
    expect(tables[0]).toBe('security_reports.reporter_email_enc');
    expect(ROTATION_TARGETS.reporter_email.owner).toBe('id');
    expect(aads[0]).toEqual({ purpose: 'reporter_email', ownerId: '498' });
  });

  it('passes the new key id and the versioned target for org_secret only (R23-c)', async () => {
    const writes: [string | undefined, string][] = [];
    for (const [purpose, after] of [
      ['org_secret', '0498'],
      ['storage_token', '0499'],
    ] as const) {
      const { s } = store(after, '2', purpose);
      s.writeValue = async (t, _id, _from, to, keyId) => (
        writes.push([t.versionColumn, `${to}@${keyId}`]),
        true
      );
      await runKeyRotation({ store: s, cipher });
    }
    expect(writes).toEqual([
      ['key_version', 'fc1.new@2'],
      ['key_version', 'fc1.new@2'],
      [undefined, 'fc1.new@2'],
    ]);
  });

  it('re-encrypts every row on the old key across batches, skipping none (56-03p)', async () => {
    const all: SecretRow[] = Array.from({ length: 1001 }, (_, i) => ({
      id: String(i).padStart(4, '0'),
      ownerId: `connector:o:${i}`,
      value: 'fc1.old',
    }));
    const { s } = store(null, '2', 'connector_token');
    s.readBatch = async (_t, after, limit) =>
      all.filter((r) => r.id > (after ?? '')).slice(0, limit);
    const written = new Set<string>();
    s.writeValue = async (_t, id) => (written.add(id), true);
    const result = await runKeyRotation({ store: s, cipher });
    expect(result).toMatchObject({ status: 'done', counts: { done: 1001, skipped: 0, failed: 0 } });
    expect(written.size).toBe(all.length);
  });

  it('rebuilds the token vault owner exactly as the API binds it (56-03p)', () => {
    const row: Record<string, string> = {
      organization_id: 'o1',
      provider: 'google',
      user_id: 'u1',
      connector_key: 'github',
      membership_id: 'm1',
    };
    const owner = (sql: string) =>
      (/^concat\((.*)\)$/.exec(sql)?.[1] ?? '')
        .split(', ')
        .map((part) => (part.startsWith("'") ? part.slice(1, -1) : (row[part] ?? '?')))
        .join('');
    expect(owner(ROTATION_TARGETS.storage_token.owner)).toBe('storage:o1:google');
    expect(owner(ROTATION_TARGETS.calendar_token.owner)).toBe('calendar:o1:u1:google');
    expect(owner(ROTATION_TARGETS.connector_token.owner)).toBe('connector:o1:github');
    expect(owner(ROTATION_TARGETS.figma_token.owner)).toBe('figma:o1:m1');
  });
});
