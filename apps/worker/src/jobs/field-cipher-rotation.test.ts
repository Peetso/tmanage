import { describe, expect, it } from 'vitest';
import { runKeyRotation, type RotationStore, type SecretRow } from './field-cipher-rotation.js';

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
function store(lastRowId: string | null, toKeyId = '2') {
  const calls: string[] = [];
  const s: RotationStore = {
    claimNext: async () => ({
      id: 'r',
      purpose: 'storage_token',
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
});
