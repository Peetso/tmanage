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
