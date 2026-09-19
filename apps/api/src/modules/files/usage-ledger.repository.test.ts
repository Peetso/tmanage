import { describe, expect, it } from 'vitest';
import { usageLedgerIdempotencyKey } from './usage-ledger.repository.js';

/**
 * USAGE-001 slice 2. The one pure piece worth a unit test: the idempotency key builder. Its
 * shape (`<uploadSessionId>:<reason>`) is what makes a replayed counter move a no-op and what
 * lets a completion's two moves and a session's later release each own a distinct key. The DB
 * suite proves the uniqueness constraint; this proves the string the constraint keys on.
 */
describe('usageLedgerIdempotencyKey', () => {
  it('joins the upload session id and reason with a single colon', () => {
    expect(usageLedgerIdempotencyKey('018f-session', 'reserve')).toBe('018f-session:reserve');
  });

  it('distinguishes the reasons of one session, so its rows never collide', () => {
    const session = '018f-session';
    const keys = ['reserve', 'commit', 'commit_release', 'expired'].map((reason) =>
      usageLedgerIdempotencyKey(session, reason),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps two sessions apart under the same reason', () => {
    expect(usageLedgerIdempotencyKey('a', 'reserve')).not.toBe(
      usageLedgerIdempotencyKey('b', 'reserve'),
    );
  });
});
