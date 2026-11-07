import { describe, expect, it } from 'vitest';
import { AdminSecurityAlertsRepository } from './security-alerts.repository.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * B13: a `file_asset.scan_failed` row the `none` scanner driver writes (`cause: no_scanner`) is
 * "not scanned", never a security-alert match; a real scanner failure still matches.
 */
describe('security alerts — no_scanner rows are not alerts (B13)', () => {
  it('the recent-match read excludes only scan_failed rows whose cause is no_scanner', async () => {
    const statements: string[] = [];
    const runner = {
      query: (sql: string) => {
        statements.push(sql);
        return Promise.resolve([]);
      },
    } as unknown as TenantQueryRunner;
    const context = { organizationId: 'org-1' } as unknown as TenantContext;
    await new AdminSecurityAlertsRepository().findRecentMatches(
      runner,
      context,
      ['file_asset.scan_failed'],
      50,
    );
    expect(statements[0]).toContain(
      "not (`audit_events`.`action` = 'file_asset.scan_failed' and coalesce(json_unquote(json_extract(`audit_events`.`metadata_json`, '$.cause')), '') = 'no_scanner')",
    );
  });
});
