import { randomInt } from 'node:crypto';
import { timestampFromUuidV7, uuidv7 } from '@tmanage/domain';

/**
 * A UUIDv7 that sorts after every id this process handed out before it.
 *
 * ## Why the plain `uuidv7()` is not enough for the credential record
 *
 * `authentication_events` and `credential_change_notices` are read oldest first with
 * `order by occurred_at, id`. `occurred_at` is the server's `current_timestamp(3)`, so two
 * rows written by one confirmation — `confirmTotpFactor` writes `mfa_factor_enrolled` and
 * then `recovery_codes_issued` in the same transaction — routinely share a millisecond, and
 * the tie falls to `id`. `uuidv7()` puts random bits after its millisecond timestamp, so two
 * ids minted in the same millisecond sort in an order chosen by chance: the record and the
 * notice queue could then say the codes were replaced *before* the factor that replaced them
 * was enrolled. That is the flake `id-002-credential-change-record.db.test.ts` caught.
 *
 * RFC 9562 §6.2 method 2 ("monotonic random"): when a fresh id would not sort after the last
 * one, the next id is the last one with its low random field advanced by a random step. Two
 * consequences, both deliberate:
 *
 * - The step is random (1 to 2^32), not 1, so a later id is not derivable from an earlier
 *   one; unguessability stays what `uuidv7()` gives.
 * - Ordering holds within this process only. That is exactly the scope that matters: the
 *   rows one change writes are written by one request, on one connection, in one
 *   transaction.
 */
let last = '';

/** Low 48 bits of the id — its last hex group, entirely random in a v7 id. */
const LOW_GROUP_START = 24;
const LOW_GROUP_MAX = 0xff_ff_ff_ff_ff_ff;

export function orderedUuidv7(): string {
  const fresh = uuidv7();
  if (fresh > last) {
    last = fresh;
    return fresh;
  }

  const low = Number.parseInt(last.slice(LOW_GROUP_START), 16) + randomInt(1, 2 ** 32);
  if (low <= LOW_GROUP_MAX) {
    last = last.slice(0, LOW_GROUP_START) + low.toString(16).padStart(12, '0');
    return last;
  }

  // The low group would overflow (a chance near 2^-16 per call): move one millisecond past
  // the last id instead. The embedded time runs that far ahead, which `occurred_at` — the
  // column every reader orders by first — never sees.
  last = uuidv7(timestampFromUuidV7(last).getTime() + 1);
  return last;
}
