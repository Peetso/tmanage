import { describe, expect, it } from 'vitest';
import { parseSeedKeys } from '@tmanage/config';
import { createSeedCipher } from './seed-cipher.js';
import { encryptSeeds, seedEncryptionStatus } from './seed-backfill.repository.js';
import type { SeedStore } from './seed-backfill.repository.js';

/**
 * The backfill's decision logic, against a table that only remembers what it was told.
 *
 * A fake rather than a database, because what is under test here is *which* rows are
 * rewritten and *what the write is guarded by* — and both are decidable from the
 * statements the sweep issues. The database suite proves the same code against a real
 * server; this one proves the parts that a real server would only agree with silently.
 */

/** Obviously fake keys: a byte repeated thirty-two times. Nothing here is a real key. */
const key = (fill: number): string => Buffer.alloc(32, fill).toString('base64url');

const V1 = createSeedCipher(parseSeedKeys(`1:${key(0x11)}`));
/** Version 2 active, version 1 kept so rows written before the rotation still open. */
const V1_AND_V2 = createSeedCipher(parseSeedKeys(`1:${key(0x11)};2:${key(0x22)}`));

const ALICE = '0198f0aa-0000-7000-8000-000000000001';
const BOB = '0198f0aa-0000-7000-8000-000000000002';

/** A real TOTP seed shape: RFC 4648 base32, which is what the column held before D07. */
const SEED = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const OTHER_SEED = 'KRUGS4ZANFZSAYJANFZSAYJAKRUGS4ZA';

interface FactorRow {
  readonly id: string;
  readonly userId: string;
  secret: string;
}

interface Statement {
  readonly sql: string;
  readonly values: readonly unknown[];
}

/**
 * `user_mfa_factors`, reduced to the three columns the sweep reads and the one it writes.
 *
 * `beforeUpdate` is how a concurrent writer is expressed: it runs once, immediately before
 * the first UPDATE reaches the table, which is exactly the window the compare-and-swap
 * exists to close.
 */
class FakeFactorTable implements SeedStore {
  readonly statements: Statement[] = [];
  private beforeUpdate: (() => void) | undefined;

  constructor(
    readonly rows: FactorRow[],
    beforeUpdate?: () => void,
  ) {
    this.beforeUpdate = beforeUpdate;
  }

  get updates(): readonly Statement[] {
    return this.statements.filter((statement) => /^\s*update/i.test(statement.sql));
  }

  async query(sql: string, values?: unknown[]): Promise<[unknown, unknown]> {
    const params = values ?? [];
    this.statements.push({ sql, values: [...params] });

    if (/^\s*select/i.test(sql)) {
      return [
        this.rows.map((row) => ({ id: row.id, user_id: row.userId, secret: row.secret })),
        [],
      ];
    }

    if (/^\s*update/i.test(sql)) {
      this.beforeUpdate?.();
      this.beforeUpdate = undefined;
      const [next, id, previous] = params as [string, string, string];
      const row = this.rows.find((candidate) => candidate.id === id);
      if (row === undefined || row.secret !== previous) return [{ affectedRows: 0 }, []];
      row.secret = next;
      return [{ affectedRows: 1 }, []];
    }

    throw new Error(`the backfill issued an unexpected statement: ${sql}`);
  }
}

function tamper(envelope: string): string {
  const parts = envelope.split('.');
  const ciphertext = parts[3];
  if (ciphertext === undefined) throw new Error(`not an envelope: ${envelope}`);
  parts[3] = (ciphertext[0] === 'A' ? 'B' : 'A') + ciphertext.slice(1);
  return parts.join('.');
}

describe('encryptSeeds', () => {
  it('encrypts a row left in plaintext and counts it as such', async () => {
    const table = new FakeFactorTable([{ id: 'f1', userId: ALICE, secret: SEED }]);

    const report = await encryptSeeds(table, V1);

    expect(report.plaintextEncrypted).toBe(1);
    expect(report.rotated).toBe(0);
    expect(report.unchanged).toBe(0);
    expect(report.failed).toBe(0);
    expect(table.rows[0]!.secret.startsWith('mfa1.1.')).toBe(true);
    // The point of the sweep: the same seed, no longer readable from the column.
    expect(V1.decrypt(table.rows[0]!.secret, { userId: ALICE })).toBe(SEED);
  });

  it('re-encrypts a row written under an older key under the active one', async () => {
    const old = V1.encrypt(SEED, { userId: ALICE });
    const table = new FakeFactorTable([{ id: 'f1', userId: ALICE, secret: old }]);

    const report = await encryptSeeds(table, V1_AND_V2);

    expect(report.rotated).toBe(1);
    expect(report.plaintextEncrypted).toBe(0);
    expect(table.rows[0]!.secret.startsWith('mfa1.2.')).toBe(true);
    expect(V1_AND_V2.decrypt(table.rows[0]!.secret, { userId: ALICE })).toBe(SEED);
  });

  it('leaves a row already on the active key alone, and issues no write for it', async () => {
    const current = V1_AND_V2.encrypt(SEED, { userId: ALICE });
    const table = new FakeFactorTable([{ id: 'f1', userId: ALICE, secret: current }]);

    const report = await encryptSeeds(table, V1_AND_V2);

    expect(report.unchanged).toBe(1);
    expect(table.updates).toHaveLength(0);
    // Untouched, not merely equivalent: a re-encryption would have drawn a fresh IV.
    expect(table.rows[0]!.secret).toBe(current);
  });

  /**
   * One statement per row, each guarded by the exact value the sweep read.
   *
   * A single `UPDATE … WHERE secret NOT LIKE 'mfa1.%'` would be shorter and would clobber
   * every enrolment that completed while the sweep was running. The predicate below is the
   * whole difference: a row that changed underneath is not written.
   */
  it('writes each row in its own statement, guarded by the value it read', async () => {
    const table = new FakeFactorTable([
      { id: 'f1', userId: ALICE, secret: SEED },
      { id: 'f2', userId: BOB, secret: OTHER_SEED },
    ]);

    await encryptSeeds(table, V1);

    expect(table.updates).toHaveLength(2);
    for (const [index, statement] of table.updates.entries()) {
      expect(statement.sql).toMatch(/update\s+user_mfa_factors/i);
      expect(statement.sql).toMatch(/where\s+id\s*=\s*\?\s+and\s+secret\s*=\s*\?/i);
      expect(statement.values).toHaveLength(3);
      expect(statement.values[1]).toBe(index === 0 ? 'f1' : 'f2');
      expect(statement.values[2]).toBe(index === 0 ? SEED : OTHER_SEED);
    }
  });

  it('does not clobber a row that changed between the read and the write', async () => {
    const table = new FakeFactorTable([{ id: 'f1', userId: ALICE, secret: SEED }], () => {
      // Someone re-enrolled while the sweep was walking the table.
      table.rows[0]!.secret = V1.encrypt(OTHER_SEED, { userId: ALICE });
    });

    const report = await encryptSeeds(table, V1);

    expect(report.failed).toBe(1);
    expect(report.plaintextEncrypted).toBe(0);
    expect(report.failures).toEqual([{ factorId: 'f1', reason: 'concurrently_changed' }]);
    expect(V1.decrypt(table.rows[0]!.secret, { userId: ALICE })).toBe(OTHER_SEED);
  });

  it('reports a row it cannot open rather than overwriting it', async () => {
    const tampered = tamper(V1.encrypt(SEED, { userId: ALICE }));
    const table = new FakeFactorTable([
      { id: 'f1', userId: ALICE, secret: tampered },
      { id: 'f2', userId: BOB, secret: 'mfa1.9' },
    ]);

    const report = await encryptSeeds(table, V1_AND_V2);

    expect(report.failed).toBe(2);
    expect(report.failures).toEqual([
      { factorId: 'f1', reason: 'authentication_failed' },
      { factorId: 'f2', reason: 'malformed' },
    ]);
    // A row nobody can decrypt is evidence. Encrypting it again would destroy it.
    expect(table.updates).toHaveLength(0);
    expect(table.rows[0]!.secret).toBe(tampered);
    expect(table.rows[1]!.secret).toBe('mfa1.9');
  });

  /**
   * The sweep is run by an operator reading its output, and its output goes into a terminal
   * scrollback and quite possibly a ticket. Nothing it says may be a seed.
   */
  it('says nothing that contains a seed or a stored value', async () => {
    const table = new FakeFactorTable([
      { id: 'f1', userId: ALICE, secret: SEED },
      { id: 'f2', userId: BOB, secret: tamper(V1.encrypt(OTHER_SEED, { userId: BOB })) },
    ]);

    const report = await encryptSeeds(table, V1);
    const printed = JSON.stringify(report);

    expect(printed).not.toContain(SEED);
    expect(printed).not.toContain(OTHER_SEED);
    expect(printed).not.toContain('mfa1.');
  });

  /**
   * The failure an operator produces by accident: a key is dropped from
   * `AUTH_MFA_SEED_KEYS` while rows are still written under it.
   *
   * `needsRotation` means "not the active version", so such a row is picked up for rewriting
   * and then cannot be opened. It has to be counted and named — not retried forever, and not
   * allowed to stop the sweep, because the rows after it are the ones that can still be
   * fixed. Hence the second row: the run walks past the failure and encrypts it.
   */
  it('counts a row under a key the keyring no longer holds, and keeps going', async () => {
    const underV2 = V1_AND_V2.encrypt(SEED, { userId: ALICE });
    const table = new FakeFactorTable([
      { id: 'f1', userId: ALICE, secret: underV2 },
      { id: 'f2', userId: BOB, secret: OTHER_SEED },
    ]);

    const report = await encryptSeeds(table, V1);

    expect(report.failed).toBe(1);
    expect(report.failures).toEqual([{ factorId: 'f1', reason: 'unknown_key_version' }]);
    // Left exactly as found: a row this deployment cannot open is evidence, not scrap.
    expect(table.rows[0]!.secret).toBe(underV2);
    // And the run did not stop at it.
    expect(report.plaintextEncrypted).toBe(1);
    expect(V1.decrypt(table.rows[1]!.secret, { userId: BOB })).toBe(OTHER_SEED);
  });

  it('counts an empty stored value as a failure rather than encrypting nothing', async () => {
    const table = new FakeFactorTable([{ id: 'f1', userId: ALICE, secret: '' }]);

    const report = await encryptSeeds(table, V1);

    expect(report.failures).toEqual([{ factorId: 'f1', reason: 'empty' }]);
    expect(table.updates).toHaveLength(0);
  });
});

describe('seedEncryptionStatus', () => {
  it('counts rows per key version, plus the plaintext and the unreadable', async () => {
    const table = new FakeFactorTable([
      { id: 'f1', userId: ALICE, secret: SEED },
      { id: 'f2', userId: ALICE, secret: V1.encrypt(SEED, { userId: ALICE }) },
      { id: 'f3', userId: BOB, secret: V1_AND_V2.encrypt(SEED, { userId: BOB }) },
      { id: 'f4', userId: BOB, secret: V1_AND_V2.encrypt(OTHER_SEED, { userId: BOB }) },
      { id: 'f5', userId: BOB, secret: 'mfa1.9' },
    ]);

    const status = await seedEncryptionStatus(table, V1_AND_V2);

    expect(status.total).toBe(5);
    expect(status.plaintext).toBe(1);
    expect(status.unreadable).toBe(1);
    expect(status.byVersion).toEqual([
      { version: 1, rows: 1 },
      { version: 2, rows: 2 },
    ]);
  });

  it('touches nothing', async () => {
    const table = new FakeFactorTable([{ id: 'f1', userId: ALICE, secret: SEED }]);

    await seedEncryptionStatus(table, V1_AND_V2);

    expect(table.updates).toHaveLength(0);
    expect(table.rows[0]!.secret).toBe(SEED);
  });
});
