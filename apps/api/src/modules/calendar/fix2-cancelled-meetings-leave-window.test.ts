import { describe, expect, it } from 'vitest';
import type {
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { MeetingAgendaRepository } from './meeting-agenda.repository.js';

/**
 * FIX2 (live 2026-11-09): a cancelled meeting stayed in the day capsule above My Day ("Today ·
 * Mon 9 Nov / Now …") and in the week grid, because the window read the grid and the capsule
 * share filtered soft-deleted rows only. Cancelling keeps the row (notes, decisions) and sets
 * `cancelled_at`, so the window read must leave it out.
 */
describe('the meetings window read', () => {
  it('leaves cancelled meetings out, as well as deleted ones', async () => {
    const statements: string[] = [];
    const capture = async (sql: string): Promise<QueryRows> => {
      statements.push(sql);
      return [] as unknown as QueryRows;
    };
    const runner = { execute: capture, query: capture } as unknown as TenantQueryRunner;
    const context = { organizationId: '01a1be4c-9e7a-77d3-b425-6acc6d1d8678' } as TenantContext;
    await new MeetingAgendaRepository().listInWindow(runner, context, {
      fromInclusive: new Date('2026-11-09T00:00:00Z'),
      toExclusive: new Date('2026-11-16T00:00:00Z'),
      limit: 100,
    });
    const sql = statements.join('\n').toLowerCase();
    expect(sql).toMatch(/`?cancelled_at`? is null/u);
    expect(sql).toMatch(/`?deleted_at`? is null/u);
  });
});
