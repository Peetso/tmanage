import type { FactoryProvider } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { ObjectStore } from '@tmanage/storage';
import type { PrivacyDeletionRequestRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { erasableTables } from './privacy-erasure.repository.js';
import type { PrivacyPass } from './privacy-job.js';
import { PRIVACY_PASS, PrivacyModule } from './privacy.module.js';

/**
 * PURGEFIX — the company erasure deletes on the ERASURE_DATABASE (`tmanage_erasure`), never on the
 * runtime database, whose credential withholds DELETE from about half the tenant tables.
 * ACCOUNTFIX — the account erasure likewise: the runtime credential holds no DELETE on the
 * credential tables and no UPDATE on either sign-in log.
 */

const context = {
  organizationId: '00000000-0000-4000-8000-0000000000a1',
  correlationId: 'c',
} as unknown as TenantContext;
const row = { id: 'r1', kind: 'company', status: 'executed' } as PrivacyDeletionRequestRow;

function passFrom(runtime: TenantDatabase, erasure: TenantDatabase): PrivacyPass {
  const provider = PrivacyModule.register().providers?.find(
    (candidate): candidate is FactoryProvider =>
      typeof candidate === 'object' && 'provide' in candidate && candidate.provide === PRIVACY_PASS,
  );
  if (provider === undefined) throw new Error('PrivacyModule registers no PRIVACY_PASS');
  const store = { remove: () => Promise.resolve() } as unknown as ObjectStore;
  return provider.useFactory(
    runtime,
    store,
    undefined,
    undefined,
    undefined,
    undefined,
    erasure,
  ) as PrivacyPass;
}

describe('PrivacyModule — the company erasure runs on the erasure database', () => {
  it('sends every erasure DELETE to ERASURE_DATABASE and none to the runtime database', async () => {
    const runtimeCalls: string[] = [];
    const runtime = {
      // The export purge finds nothing; the final "mark erased" is the runtime's one transaction.
      read: () => Promise.resolve([]),
      transaction: () => {
        runtimeCalls.push('transaction');
        return Promise.resolve(false);
      },
    } as unknown as TenantDatabase;

    const deletes: string[] = [];
    const runner = {
      query: () => Promise.resolve([]),
      execute: (sql: string) => {
        deletes.push(sql);
        return Promise.resolve({ affectedRows: 0 });
      },
    };
    const erasure = {
      read: (_c: unknown, fn: (r: unknown) => unknown) => fn(runner),
      transaction: (_c: unknown, fn: (r: unknown) => unknown) => fn(runner),
    } as unknown as TenantDatabase;

    await passFrom(runtime, erasure).eraseCompany(context, row);

    // One statement per erasable table, in the erasure's order, each naming that table.
    expect(deletes.map((sql) => /`([a-z0-9_]+)`/u.exec(sql)?.[1])).toEqual(erasableTables());
    expect(runtimeCalls).toEqual(['transaction']);
  });
});

describe('PrivacyModule — the account erasure runs on the erasure database', () => {
  it('sends every account erasure statement to ERASURE_DATABASE', async () => {
    const runtimeCalls: string[] = [];
    const runtime = {
      transaction: () => {
        runtimeCalls.push('transaction');
        return Promise.resolve(false);
      },
    } as unknown as TenantDatabase;

    const writes: string[] = [];
    const runner = {
      query: (sql: string) => {
        if (sql.startsWith('select')) {
          return Promise.resolve(sql.includes('from `users`') ? [['ana@x.test']] : []);
        }
        // Each write as "<verb> <table>".
        writes.push(`${sql.split(' ')[0] ?? ''} ${/`([a-z0-9_]+)`/u.exec(sql)?.[1] ?? ''}`);
        return Promise.resolve({ affectedRows: 1 });
      },
    };
    const run = (_o: unknown, fn: (r: unknown) => unknown) => fn(runner);
    const erasure = {
      transaction: run,
      bootstrapRead: run,
      identityTransaction: run,
    } as unknown as TenantDatabase;
    const account = {
      id: 'r2',
      kind: 'account',
      status: 'executed',
      subjectUserId: '00000000-0000-4000-8000-0000000000c1',
    } as PrivacyDeletionRequestRow;

    await passFrom(runtime, erasure).eraseAccount(context, account);

    expect(writes).toContain('update client_invoice_events');
    expect(writes).toContain('update users');
    expect(writes).toContain('delete user_passwords');
    // Only the final "mark erased" stays on the runtime credential.
    expect(runtimeCalls).toEqual(['transaction']);
  });
});
