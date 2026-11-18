import { describe, expect, it } from 'vitest';
import { PERSON_MAIL_SQL, createPersonMailStore } from './person-mail-store.js';
import type { WorkerDatabase, WorkerTransaction } from './worker-database.js';

/** Answers only the switch read: `value` is the `mail.tips_enabled` row, or none. */
function switchDatabase(value: string | null): WorkerDatabase {
  const tx: WorkerTransaction = {
    query<T>(sql: string): Promise<T> {
      const rows: unknown[] = sql === PERSON_MAIL_SQL.switch && value !== null ? [{ value }] : [];
      return Promise.resolve(rows as T);
    },
  };
  return {
    transaction: (work) => work(tx),
    read: (work) => work(tx),
    end: () => Promise.resolve(),
  };
}

describe('EMAILBUILD2 — person-mail platform switch', () => {
  it('is on only when the row says on: absent or off stops the sweep', async () => {
    expect(await createPersonMailStore(switchDatabase(null)).tipsSwitchOn()).toBe(false);
    expect(await createPersonMailStore(switchDatabase('off')).tipsSwitchOn()).toBe(false);
    expect(await createPersonMailStore(switchDatabase('on')).tipsSwitchOn()).toBe(true);
  });
});

describe('MAILREST — guarded claim, re-claim and settle', () => {
  function recording(affectedRows: number) {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const tx: WorkerTransaction = {
      query<T>(sql: string, params: readonly unknown[] = []): Promise<T> {
        calls.push({ sql, params });
        return Promise.resolve({ affectedRows } as T);
      },
    };
    const database: WorkerDatabase = {
      transaction: (work) => work(tx),
      read: (work) => work(tx),
      end: () => Promise.resolve(),
    };
    return { store: createPersonMailStore(database), calls };
  }

  const candidate = {
    organizationId: 'org-1',
    membershipId: 'm-1',
    userId: 'u-1',
    role: 'owner',
    email: 'u@example.test',
    displayName: 'Sara',
    locale: null,
    slug: 'acme',
    workspaceName: 'Acme',
  };
  const AT = new Date('2026-11-18T10:00:00.000Z');

  it('claims as attempt 1 and re-claims only the row at the attempt it read', async () => {
    expect(PERSON_MAIL_SQL.claim).toContain(`'sending', 1`);
    expect(PERSON_MAIL_SQL.reclaim).toMatch(/status = 'retry' AND attempts = \?/u);
    expect(PERSON_MAIL_SQL.settle).toMatch(/status = 'sending' AND attempts = \?/u);
    const won = recording(1);
    expect(await won.store.reclaim({ candidate, tipId: 'feature:invoices', attempts: 2 }, AT)).toBe(
      true,
    );
    expect(won.calls[0]?.params).toEqual(['org-1', 'u-1', 'feature:invoices', 2]);
    const lost = recording(0);
    expect(
      await lost.store.reclaim({ candidate, tipId: 'feature:invoices', attempts: 2 }, AT),
    ).toBe(false);
  });

  it('settles sent with the send time, and a retry with its due time and error token', async () => {
    const { store, calls } = recording(1);
    await store.settle(candidate, 'feature:invoices', 1, { status: 'sent' }, AT);
    const due = new Date(AT.getTime() + 3_600_000);
    await store.settle(
      candidate,
      'feature:invoices',
      2,
      { status: 'retry', nextAttemptAt: due, error: 'smtp_451' },
      AT,
    );
    expect(calls[0]?.params).toEqual([
      'sent',
      null,
      null,
      AT,
      'org-1',
      'u-1',
      'feature:invoices',
      1,
    ]);
    expect(calls[1]?.params).toEqual([
      'retry',
      due,
      'smtp_451',
      null,
      'org-1',
      'u-1',
      'feature:invoices',
      2,
    ]);
  });
});
