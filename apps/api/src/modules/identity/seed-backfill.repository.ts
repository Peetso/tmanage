import type { RowDataPacket } from 'mysql2/promise';
import { SeedCipherError } from './seed-cipher.js';
import type { SeedCipher, SeedCipherRejection } from './seed-cipher.js';

/**
 * The sweep that gets `user_mfa_factors.secret` onto the current key — review finding D07.
 *
 * Encryption without a way to re-encrypt is a one-way door. Two situations need this file:
 * a deployment upgrading past D07, whose rows still hold the bare base32 seed the
 * authenticator handed over, and a key rotation, where a higher version has been appended
 * to `AUTH_MFA_SEED_KEYS` and the rows written under the old one have to catch up before
 * that key can be dropped. Both are the same walk over the table, which is why they are one
 * function rather than two that would drift.
 *
 * It lives beside `seed-cipher.ts` rather than in `common/database/` because decryption is
 * confined to `modules/identity/` and this is the only other place that opens an envelope.
 * `cli.ts` calls it; so does the database suite, with the admin connection, which is why the
 * connection is a parameter and never something this file goes and finds.
 *
 * The `.repository.ts` suffix is load-bearing rather than decorative: it is what puts this
 * file inside the allowlist in `eslint.config.js` that decides which modules may hold a
 * driver handle and write SQL (25-AUTH-AND-TENANT-ISOLATION §6). Nothing here goes through
 * `TenantDatabase`, because there is no tenant — `user_mfa_factors` is on the identity path,
 * and this runs as a maintenance command rather than inside a request.
 *
 * ## Row by row, and never blind
 *
 * One `UPDATE` per row, each carrying the exact value the sweep read as part of its
 * predicate. The tempting alternative — one statement rewriting everything that does not
 * look encrypted — is wrong in a way that is invisible until it costs someone their second
 * factor: enrolments continue while the sweep runs, and a set-based rewrite would overwrite
 * a factor confirmed a millisecond ago with a re-encryption of the value it replaced. A row
 * that moved underneath is reported as a failure and left exactly as the other writer left
 * it; running the sweep again picks it up.
 *
 * A row that cannot be opened — a tampered ciphertext, an envelope naming a key the
 * environment does not hold — is counted and skipped, never rewritten. Re-encrypting it
 * would replace evidence of tampering with something that looks correct, and would destroy
 * the only copy of a seed whose key is merely missing from this process's environment.
 *
 * ## Nothing it says is a secret
 *
 * The report names factor ids and reasons. Not seeds, not stored values, not key material:
 * this output is read in a terminal and pasted into tickets, and an operator running the
 * backfill should not thereby create a second copy of every seed in the system.
 */

/**
 * What this file needs of a connection: the ability to run one statement.
 *
 * Structural rather than `Connection`, so the same code takes the CLI's single migration
 * connection and the database suite's admin pool without either being converted into the
 * other.
 */
export interface SeedStore {
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
}

/**
 * Why one row was not re-encrypted. `concurrently_changed` and `empty` are this file's own;
 * the rest come from the cipher and mean exactly what they mean there.
 */
export type SeedBackfillFailureReason = SeedCipherRejection | 'concurrently_changed' | 'empty';

export interface SeedBackfillFailure {
  readonly factorId: string;
  readonly reason: SeedBackfillFailureReason;
}

export interface SeedBackfillReport {
  /** Rows that held a bare seed and now hold an envelope. */
  readonly plaintextEncrypted: number;
  /** Rows that held an envelope under an older key and now hold one under the active key. */
  readonly rotated: number;
  /** Rows already on the active key. Not written. */
  readonly unchanged: number;
  readonly failed: number;
  readonly failures: readonly SeedBackfillFailure[];
}

export interface SeedVersionCount {
  readonly version: number;
  readonly rows: number;
}

export interface SeedStatusReport {
  readonly total: number;
  /** Rows with no envelope at all: the D07 finding, still open, counted. */
  readonly plaintext: number;
  /** Rows that carry an envelope this process cannot parse. Neither plaintext nor usable. */
  readonly unreadable: number;
  /** Rows per key version, ascending. A version with no rows does not appear. */
  readonly byVersion: readonly SeedVersionCount[];
}

const ENVELOPE_PREFIX = 'mfa1.';

const SELECT_SECRETS = 'SELECT id, user_id, secret FROM user_mfa_factors ORDER BY id';

/**
 * The compare-and-swap. `secret = ?` is the previous value, read moments ago; without it
 * this statement is a blind overwrite of whatever is there now.
 */
const REPLACE_SECRET = 'UPDATE user_mfa_factors SET secret = ? WHERE id = ? AND secret = ?';

interface StoredSecret {
  readonly id: string;
  readonly userId: string;
  readonly secret: string;
}

/**
 * Re-encrypt every row that is not already under the active key.
 *
 * Returns rather than prints, so the database suite can assert on the counts and the CLI can
 * decide how to render them.
 */
export async function encryptSeeds(
  store: SeedStore,
  cipher: SeedCipher,
): Promise<SeedBackfillReport> {
  const rows = await readSecrets(store);

  let plaintextEncrypted = 0;
  let rotated = 0;
  let unchanged = 0;
  const failures: SeedBackfillFailure[] = [];

  for (const row of rows) {
    if (!cipher.needsRotation(row.secret)) {
      unchanged += 1;
      continue;
    }

    const wasEncrypted = row.secret.startsWith(ENVELOPE_PREFIX);
    let seed: string;
    if (wasEncrypted) {
      // An `mfa1.` value is an envelope or it is broken. It is never a seed, so the only
      // way to the plaintext is through the cipher, and a refusal here ends this row.
      try {
        seed = cipher.decrypt(row.secret, { userId: row.userId });
      } catch (error) {
        if (!(error instanceof SeedCipherError)) throw error;
        failures.push({ factorId: row.id, reason: error.reason });
        continue;
      }
    } else if (row.secret === '') {
      // `encrypt` refuses an empty seed, and rightly: there would be nothing to protect.
      // Reported rather than thrown, so one impossible row does not stop the sweep.
      failures.push({ factorId: row.id, reason: 'empty' });
      continue;
    } else {
      seed = row.secret;
    }

    const applied = await replaceSecret(store, {
      id: row.id,
      previous: row.secret,
      next: cipher.encrypt(seed, { userId: row.userId }),
    });

    if (!applied) {
      failures.push({ factorId: row.id, reason: 'concurrently_changed' });
    } else if (wasEncrypted) {
      rotated += 1;
    } else {
      plaintextEncrypted += 1;
    }
  }

  return { plaintextEncrypted, rotated, unchanged, failed: failures.length, failures };
}

/**
 * Count what the table holds, without opening anything.
 *
 * Deliberately parse-only: this is the command an operator runs to decide whether an old key
 * may be removed from `AUTH_MFA_SEED_KEYS`, and that question is answered by the version
 * each envelope names. Decrypting to answer it would put every seed in this process's memory
 * for no reason.
 */
export async function seedEncryptionStatus(
  store: SeedStore,
  cipher: SeedCipher,
): Promise<SeedStatusReport> {
  const rows = await readSecrets(store);

  let plaintext = 0;
  let unreadable = 0;
  const perVersion = new Map<number, number>();

  for (const row of rows) {
    const version = cipher.keyVersionOf(row.secret);
    if (version !== null) {
      perVersion.set(version, (perVersion.get(version) ?? 0) + 1);
    } else if (row.secret.startsWith(ENVELOPE_PREFIX)) {
      unreadable += 1;
    } else {
      plaintext += 1;
    }
  }

  return {
    total: rows.length,
    plaintext,
    unreadable,
    byVersion: [...perVersion.entries()]
      .map(([version, count]) => ({ version, rows: count }))
      .sort((left, right) => left.version - right.version),
  };
}

async function readSecrets(store: SeedStore): Promise<readonly StoredSecret[]> {
  const [rows] = await store.query(SELECT_SECRETS);
  return (rows as RowDataPacket[]).map((row) => ({
    id: String(row['id']),
    userId: String(row['user_id']),
    secret: String(row['secret']),
  }));
}

async function replaceSecret(
  store: SeedStore,
  row: { id: string; previous: string; next: string },
): Promise<boolean> {
  const [result] = await store.query(REPLACE_SECRET, [row.next, row.id, row.previous]);
  return Number((result as { affectedRows?: number }).affectedRows ?? 0) > 0;
}
