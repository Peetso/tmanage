import { describe, expect, it } from 'vitest';
import { analyzeStatement } from '../../common/database/tenant-guard.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { RecentItemsRepository } from './recent-items.repository.js';

/**
 * FIX5 item 6d (B11): "Recently viewed" listed a deleted task and deleted docs. The list read now
 * keeps only recents whose target still exists in this tenant and is not soft-deleted, and the
 * statement it sends passes the static tenant guard (every subquery bound to the acting org).
 */

const ORG = '0198f4a2-1c00-7000-8000-00000000000a';
const MEMBERSHIP = '0198f4a2-1c00-7000-8000-0000000000e1';

function capture() {
  const sent: { sql: string; params: readonly unknown[] }[] = [];
  const runner = {
    query: (sql: string, params: readonly unknown[]) => {
      sent.push({ sql, params });
      return Promise.resolve([] as unknown[]);
    },
  } as unknown as TenantQueryRunner;
  return { runner, sent };
}

describe('RecentItemsRepository.listForMembership (FIX5 item 6d)', () => {
  it('filters out deleted work items, docs and meetings, and recents with no target', async () => {
    const { runner, sent } = capture();
    const context = { organizationId: ORG, membershipId: MEMBERSHIP } as unknown as TenantContext;
    await new RecentItemsRepository().listForMembership(runner, context, MEMBERSHIP);
    expect(sent).toHaveLength(1);
    const { sql, params } = sent[0]!;
    const flat = sql.replace(/\s+/gu, ' ');
    expect(flat).toContain(
      'from work_items rv_wi where rv_wi.organization_id = ? and rv_wi.id = `home_recent_items`.`object_id` and rv_wi.deleted_at is null',
    );
    expect(flat).toContain('rv_doc.deleted_at is null');
    expect(flat).toContain('rv_mtg.deleted_at is null');
    expect(flat).toContain('from projects rv_prj where rv_prj.organization_id = ?');
    // Every subquery is pinned to the acting organization, never another value.
    expect(params.filter((value) => value === ORG).length).toBeGreaterThanOrEqual(5);
    expect(analyzeStatement(sql, params, ORG).violations).toEqual([]);
  });
});
