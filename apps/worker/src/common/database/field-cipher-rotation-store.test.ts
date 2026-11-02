import { describe, expect, it } from 'vitest';
import { ROTATION_TARGETS } from '../../jobs/field-cipher-rotation.js';
import { createRotationStore } from './field-cipher-rotation-store.js';
import type { WorkerDatabase, WorkerTransaction } from './worker-database.js';

/** R23-c: the CAS write stamps `key_version` on a versioned target; unversioned is unchanged. */
function fakeDb(affectedRows: number) {
  const seen: { sql: string; params: readonly unknown[] }[] = [];
  const tx: WorkerTransaction = {
    query: async <T>(sql: string, params: readonly unknown[] = []) => (
      seen.push({ sql, params }),
      { affectedRows } as T
    ),
  };
  const db = { transaction: (w: never) => (w as (t: WorkerTransaction) => unknown)(tx) };
  return { store: createRotationStore(db as unknown as WorkerDatabase), seen };
}

describe('rotation store writeValue (R23-c)', () => {
  it('stamps key_version for org_secrets, binding [to, toKeyId, id, from]', async () => {
    const { store, seen } = fakeDb(1);
    expect(await store.writeValue(ROTATION_TARGETS.org_secret, 'id1', 'old', 'new', 'k2')).toBe(
      true,
    );
    expect(seen[0]?.sql).toBe(
      'UPDATE org_secrets SET ciphertext = ?, key_version = ? WHERE id = ? AND ciphertext = ?',
    );
    expect(seen[0]?.params).toEqual(['new', 'k2', 'id1', 'old']);
  });

  it('keeps the unversioned statement byte-identical, and a CAS miss returns false', async () => {
    const { store, seen } = fakeDb(0);
    expect(await store.writeValue(ROTATION_TARGETS.storage_token, 'id1', 'o', 'n', 'k2')).toBe(
      false,
    );
    expect(seen[0]?.sql).toBe(
      'UPDATE storage_connections SET refresh_token_enc = ? WHERE id = ? AND refresh_token_enc = ?',
    );
    expect(seen[0]?.params).toEqual(['n', 'id1', 'o']);
  });
});
