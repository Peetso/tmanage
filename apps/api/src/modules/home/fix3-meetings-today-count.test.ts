import { describe, expect, it } from 'vitest';
import type {
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { HomePulseRepository } from './home-pulse.repository.js';

/**
 * FIX3 item 2 (live check a6f66e47, M1): My Day's "meetings today" counted cancelled meetings —
 * it showed 3 after the meeting was cancelled and had left the calendar. The count's read now
 * leaves cancelled and deleted meetings out, as the calendar window read does since FIX2.
 */
describe("My Day's meetings-today read", () => {
  it('leaves cancelled and deleted meetings out', async () => {
    const statements: string[] = [];
    const capture = async (sql: string): Promise<QueryRows> => {
      statements.push(sql);
      return [] as unknown as QueryRows;
    };
    const runner = { execute: capture, query: capture } as unknown as TenantQueryRunner;
    const context = { organizationId: '01a1be4c-9e7a-77d3-b425-6acc6d1d8678' } as TenantContext;
    await new HomePulseRepository().listMeetingsInWindow(
      runner,
      context,
      new Date('2026-11-09T00:00:00Z'),
      new Date('2026-11-10T00:00:00Z'),
    );
    const sql = statements.join('\n').toLowerCase();
    expect(sql).toMatch(/`?cancelled_at`? is null/u);
    expect(sql).toMatch(/`?deleted_at`? is null/u);
  });
});
