import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * platform-admin v2 · PA-05 (SPEC §3.2 "Exclusions", §9 row 1). The hidden Support-mode
 * membership (`role = 'platform_support'`) is a real `memberships` row, so every query that lists
 * "the people of this organization" must leave it out — or TManage support would show up in the
 * directory, the members page, the seat count, mention pickers and notification fan-out.
 *
 * A grep test, on purpose: each named file must carry the predicate, either the Drizzle form
 * `ne(memberships.role, PLATFORM_SUPPORT_ROLE)` or the SQL form `role <> 'platform_support'`,
 * as many times as it has roster reads. A new roster query that forgets it fails here.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const API_MODULES = resolve(HERE, '..');
const REPO = resolve(HERE, '../../../../..');

const PREDICATE = /ne\(memberships\.role, PLATFORM_SUPPORT_ROLE\)|role <> 'platform_support'/gu;

interface Exclusion {
  readonly file: string;
  readonly what: string;
  readonly at_least: number;
}

const EXCLUSIONS: readonly Exclusion[] = [
  {
    file: resolve(API_MODULES, 'tenancy/memberships.repository.ts'),
    what: 'members page and member lists (list, listWithNames)',
    at_least: 2,
  },
  {
    file: resolve(API_MODULES, 'people/directory.repository.ts'),
    what: 'People directory (and the DM people picker that reads it)',
    at_least: 1,
  },
  { file: resolve(API_MODULES, 'people/teams.repository.ts'), what: 'team rosters', at_least: 1 },
  {
    file: resolve(API_MODULES, 'identity/admin-sessions.repository.ts'),
    what: 'admin sessions list',
    at_least: 1,
  },
  {
    file: resolve(API_MODULES, 'conversations/mention-candidates.repository.ts'),
    what: 'mention picker (channel members and org-wide members)',
    at_least: 2,
  },
  {
    file: resolve(API_MODULES, 'billing/subscription.repository.ts'),
    what: 'seat count behind the plan people limit',
    at_least: 1,
  },
  {
    file: resolve(API_MODULES, 'platform-admin/platform-admin.repository.ts'),
    what: 'COMPANY_COLUMNS.people',
    at_least: 1,
  },
  {
    file: resolve(REPO, 'apps/worker/src/common/database/notifications-store.ts'),
    what: 'notification fan-out to every member',
    at_least: 2,
  },
];

describe('the hidden platform_support membership stays out of every roster', () => {
  for (const exclusion of EXCLUSIONS) {
    it(`${exclusion.what} excludes it`, () => {
      const source = readFileSync(exclusion.file, 'utf8');
      const hits = source.match(PREDICATE) ?? [];
      expect(
        hits.length,
        `${exclusion.file} must carry the platform_support predicate ${String(exclusion.at_least)}×`,
      ).toBeGreaterThanOrEqual(exclusion.at_least);
    });
  }

  it('seat counting uses the same predicate as the members page', () => {
    const seats = readFileSync(resolve(API_MODULES, 'billing/subscription.repository.ts'), 'utf8');
    expect(seats).toMatch(
      /countInternalPeople[\s\S]*ne\(memberships\.role, PLATFORM_SUPPORT_ROLE\)/u,
    );
  });
});
