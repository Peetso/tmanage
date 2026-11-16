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

/**
 * A row `status` could not turn back into a seed, and why.
 *
 * The reason is the cipher's own, minus `not_encrypted` — a bare seed is already reported as
 * `plaintext`, is not a fault, and is fixed by running the backfill.
 */
export interface SeedUnopenableFactor {
  readonly factorId: string;
  readonly reason: Exclude<SeedCipherRejection, 'not_encrypted'>;
}

export interface SeedStatusReport {
  readonly total: number;
  /** Rows with no envelope at all: the D07 finding, still open, counted. */
  readonly plaintext: number;
  /** Rows that carry an envelope this process cannot parse. Neither plaintext nor usable. */
  readonly unreadable: number;
  /** Rows per key version, ascending. A version with no rows does not appear. */
  readonly byVersion: readonly SeedVersionCount[];
  /**
   * Rows that parse but do not open: an unknown key version, a failed tag, a malformed
   * envelope. These are the rows that refuse somebody's sign-in, listed by id so an operator
   * can act on them. A `malformed` row is counted here *and* in `unreadable`; the two answer
   * different questions ("what shape is the column in" and "who is locked out").
   *
   * Disabled rows are left out, and that is the difference between a number that can reach
   * zero and one that cannot. The documented remedy for a broken factor is to disable it and
   * keep it (`docs/runbooks/deploy.md`), so listing disabled rows would mean an operator who
   * followed the runbook exactly still sees a non-zero count for ever, with nothing left to
   * do about it. A disabled row is past `listActiveFactors` and refuses nobody's sign-in.
   * The counts above still cover it: every stored value is somebody's seed until the column
   * is cleared.
   */
  readonly unopenable: readonly SeedUnopenableFactor[];
}

const ENVELOPE_PREFIX = 'mfa1.';

/**
 * `disabled_at` is read for `status` alone, to tell a row that can still refuse a sign-in
 * from one an operator has already retired. The sweep ignores it on purpose: a disabled row
 * still holds a seed, and leaving it in plaintext would defeat the point of D07.
 *
 * MFAOPTIONS (0360): only `totp` rows hold a seed. An `email` row stores `''` by design and would
 * otherwise be reported as an `empty` failure on every run.
 */
const SELECT_SECRETS =
  "SELECT id, user_id, secret, disabled_at FROM user_mfa_factors WHERE kind = 'totp' ORDER BY id";

/**
 * The compare-and-swap. `secret = ?` is the previous value, read moments ago; without it
 * this statement is a blind overwrite of whatever is there now.
 */
const REPLACE_SECRET = 'UPDATE user_mfa_factors SET secret = ? WHERE id = ? AND secret = ?';

interface StoredSecret {
  readonly id: string;
  readonly userId: string;
  readonly secret: string;
  /** `disabled_at` is set: the factor is retired and no sign-in of anybody's reaches it. */
  readonly disabled: boolean;
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
 * Count what the table holds, and say which rows will not open.
 *
 * The per-version counts are pure parsing, and they answer the question an operator asks
 * during a rotation: may this old key be dropped from `AUTH_MFA_SEED_KEYS` yet.
 *
 * The `unopenable` list answers the other one, and it is the reason this command is no
 * longer parse-only (D07 review, issue 3). A tampered envelope, or one naming a key this
 * environment no longer holds, parses perfectly and was counted under its version like any
 * healthy row — so the diagnostic an operator reached for during a lockout could not see the
 * rows causing it, and `encrypt` short-circuits the same rows as `unchanged` before any
 * decrypt. One decrypt attempt per row closes that: the seed is discarded on the same line
 * it is produced, nothing is retained and nothing is written, and this is a command a person
 * types deliberately rather than something on a request path.
 *
 * `not_encrypted` is not a failure here. It is a row the backfill has not reached, already
 * reported as `plaintext`, and calling it unopenable would tell an operator to go looking for
 * a key when the answer is to run `mfa:encrypt-seeds`.
 *
 * A disabled row is not a failure either, for the same reason inverted: it cannot refuse a
 * sign-in, and the runbook's own remedy for a broken factor is to disable it and keep the
 * row. Counting it would make `unopenable` a number that never returns to zero however
 * faithfully an operator follows the instructions. The counts are unaffected — a retired row
 * is still a row, and still holds a value the sweep must encrypt.
 */
export async function seedEncryptionStatus(
  store: SeedStore,
  cipher: SeedCipher,
): Promise<SeedStatusReport> {
  const rows = await readSecrets(store);

  let plaintext = 0;
  let unreadable = 0;
  const perVersion = new Map<number, number>();
  const unopenable: SeedUnopenableFactor[] = [];

  for (const row of rows) {
    const version = cipher.keyVersionOf(row.secret);
    if (version !== null) {
      perVersion.set(version, (perVersion.get(version) ?? 0) + 1);
    } else if (row.secret.startsWith(ENVELOPE_PREFIX)) {
      unreadable += 1;
    } else {
      plaintext += 1;
    }

    // Retired rows are counted above and go no further: `unopenable` answers "who is locked
    // out", and nobody signs in on a disabled factor. Not opening it is also one fewer
    // decrypt of a seed nobody needs.
    if (row.disabled) continue;

    try {
      // The return value is the seed, and it goes nowhere: what is under test is whether the
      // row opens, not what is inside it.
      cipher.decrypt(row.secret, { userId: row.userId });
    } catch (error) {
      if (!(error instanceof SeedCipherError)) throw error;
      if (error.reason !== 'not_encrypted') {
        unopenable.push({ factorId: row.id, reason: error.reason });
      }
    }
  }

  return {
    total: rows.length,
    plaintext,
    unreadable,
    byVersion: [...perVersion.entries()]
      .map(([version, count]) => ({ version, rows: count }))
      .sort((left, right) => left.version - right.version),
    unopenable,
  };
}

async function readSecrets(store: SeedStore): Promise<readonly StoredSecret[]> {
  const [rows] = await store.query(SELECT_SECRETS);
  return (rows as RowDataPacket[]).map((row) => ({
    id: String(row['id']),
    userId: String(row['user_id']),
    secret: String(row['secret']),
    // Anything other than SQL NULL is a disable timestamp; the value itself is never used.
    disabled: row['disabled_at'] !== null && row['disabled_at'] !== undefined,
  }));
}

async function replaceSecret(
  store: SeedStore,
  row: { id: string; previous: string; next: string },
): Promise<boolean> {
  const [result] = await store.query(REPLACE_SECRET, [row.next, row.id, row.previous]);
  return Number((result as { affectedRows?: number }).affectedRows ?? 0) > 0;
}
