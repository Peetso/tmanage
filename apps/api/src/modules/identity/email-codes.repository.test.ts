import { describe, expect, it } from 'vitest';
import type { IdentityQueryRunner } from '../../common/database/tenant-context.js';
import { EMAIL_CODE_MAX_ATTEMPTS, EMAIL_CODE_TTL_SECONDS } from './email-code.js';
import { EmailCodesRepository } from './email-codes.repository.js';

/**
 * MFAOPTIONS. The storage rules for mailed codes live in SQL — expiry against the database's
 * clock, single use, the attempt cap — so this file reads the statements the repository issues.
 * Each case names the clause it protects; dropping that clause fails it. The database suite runs
 * the same statements for real.
 */

interface Statement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function recordingRunner(affectedRows = 1): {
  runner: IdentityQueryRunner;
  statements: Statement[];
} {
  const statements: Statement[] = [];
  const runner = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      statements.push({ sql, params });
      return /^\s*select/iu.test(sql) ? [] : { affectedRows, insertId: 0 };
    },
  } as unknown as IdentityQueryRunner;
  return { runner, statements };
}

const repository = new EmailCodesRepository();
const ROW = { id: '0198f0aa-0000-7000-8000-0000000000e1', attempts: 0 };

describe('EmailCodesRepository', () => {
  it('retires the open code of the same binding before storing a new one (one code works)', async () => {
    const { runner, statements } = recordingRunner();
    await repository.create(runner, {
      userId: 'u',
      factorId: 'f',
      purpose: 'sign_in',
      bindingHash: 'b'.repeat(64),
      codeHash: 'c'.repeat(64),
    });
    expect(statements).toHaveLength(2);
    const [retire, insert] = statements as [Statement, Statement];
    expect(retire.sql).toMatch(/^update `user_mfa_email_codes` set `used_at`/iu);
    expect(retire.sql).toMatch(/`binding_hash` = \?/u);
    expect(retire.sql).toMatch(/`used_at` is null/u);
    expect(retire.params).toContain('b'.repeat(64));
    expect(insert.sql).toMatch(/^insert into `user_mfa_email_codes`/iu);
    expect(insert.sql).toContain('date_add(current_timestamp(3), interval ? second)');
    expect(insert.params).toContain(EMAIL_CODE_TTL_SECONDS);
    // Only the hash is stored.
    expect(insert.params).toContain('c'.repeat(64));
  });

  it('finds only an unspent, unexpired code, by the database clock', async () => {
    const { runner, statements } = recordingRunner();
    expect(await repository.findOpen(runner, 'b'.repeat(64))).toBeNull();
    const [select] = statements as [Statement];
    expect(select.sql).toMatch(/`used_at` is null/u);
    expect(select.sql).toMatch(/`expires_at` > current_timestamp\(3\)/u);
  });

  it('spends once: a compare-and-swap on used_at and on expiry', async () => {
    const live = recordingRunner(1);
    expect(await repository.spend(live.runner, ROW.id)).toBe(true);
    const [spend] = live.statements as [Statement];
    expect(spend.sql).toMatch(/`used_at` is null/u);
    expect(spend.sql).toMatch(/`expires_at` > current_timestamp\(3\)/u);

    const spent = recordingRunner(0);
    expect(await repository.spend(spent.runner, ROW.id)).toBe(false);
  });

  it('counts a wrong guess with a compare-and-swap, and the fifth kills the code', async () => {
    const early = recordingRunner();
    expect(await repository.recordWrongAttempt(early.runner, { ...ROW, attempts: 1 })).toBe(
      'counted',
    );
    const [count] = early.statements as [Statement];
    expect(count.sql).toMatch(/`attempts` = \?/u);
    expect(count.sql).not.toMatch(/set[^w]*`used_at`/iu);

    const last = recordingRunner();
    expect(
      await repository.recordWrongAttempt(last.runner, {
        ...ROW,
        attempts: EMAIL_CODE_MAX_ATTEMPTS - 1,
      }),
    ).toBe('dead');
    const [kill] = last.statements as [Statement];
    expect(kill.sql).toMatch(/set[^w]*`used_at` = current_timestamp\(3\)/iu);
  });

  it('calls a binding exhausted at the attempt cap', async () => {
    const { runner, statements } = recordingRunner();
    expect(await repository.isExhausted(runner, 'b'.repeat(64))).toBe(false);
    const [select] = statements as [Statement];
    expect(select.sql).toMatch(/`attempts` >= \?/u);
    expect(select.params).toContain(EMAIL_CODE_MAX_ATTEMPTS);
  });
});
