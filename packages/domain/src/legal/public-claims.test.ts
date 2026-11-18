import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as c from './public-claims.js';

const ROOT = join(import.meta.dirname, '../../../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
// WIRING3: moved from 2026-11-08 so the 52-19 record check (verified 2026-11-18) is not in the future.
const now = new Date('2026-11-18T12:00:00Z');
const tree = (dir: string): string[] =>
  readdirSync(join(ROOT, dir)).flatMap((n) => {
    if (statSync(join(ROOT, dir, n)).isDirectory())
      return n === 'messages' ? [] : tree(`${dir}/${n}`);
    return /(?<!\.test)\.tsx?$/u.test(n) ? [`${dir}/${n}`] : [];
  });
const PUBLIC_SOURCES = [
  'apps/api/src/modules/public-site/plan-catalog.service.ts',
  'apps/api/src/modules/public-site/trust-content.service.ts',
  'apps/web/src/components/website/pages/integrations/integrations-data.ts',
];

describe('public claims (57-05, 56-24)', () => {
  it('fails on a shipped claim without fresh proof, and on unproven words in public copy', () => {
    expect(c.validateClaimRegistry(c.PUBLIC_CLAIMS, now)).toEqual([]);
    for (const locale of ['en', 'ar'] as const) {
      const catalog = read(`apps/web/src/lib/i18n/messages/${locale}.json`);
      expect(c.findClaimViolations(Object.entries(JSON.parse(catalog)), locale, now)).toEqual([]);
    }
    const lines = PUBLIC_SOURCES.flatMap((f) =>
      read(f)
        .split('\n')
        .map((l) => [f, l] as const),
    );
    const said = lines.filter(([, l]) => !l.includes("status: 'planned'"));
    expect(c.findClaimViolations(said, 'en', now)).toEqual([]);
  });

  it('fails while a component still renders a removed claim key', () => {
    const files = [...tree('apps/web/src'), ...tree('apps/api/src')].map((f) => [f, read(f)]);
    const hits = c.REMOVED_CLAIM_KEYS.flatMap((key) => {
      const tail = `}${key.slice(key.lastIndexOf('.') + 1)}`;
      return files.filter(([, s]) => s!.includes(key) || s!.includes(tail)).map(([f]) => f);
    });
    expect(hits).toEqual([]);
  }, 60_000);

  it('flips a shipped claim back to hidden when its proof fails, is stale or incomplete', () => {
    const proof = c.PUBLIC_CLAIMS[0]!.proofIds[0]!;
    const ok = {
      ...c.PUBLIC_CLAIMS[0]!,
      status: 'shipped' as const,
      verifiedAt: '2026-10-01',
      proofRunRef: 'r1',
    };
    expect(c.effectiveClaimStatus(ok, now)).toBe('shipped');
    expect(c.effectiveClaimStatus(ok, now, { [proof]: 'fail' })).toBe('hidden');
    expect(c.effectiveClaimStatus({ ...ok, verifiedAt: '2026-07-01' }, now)).toBe('hidden');
    expect(
      c.findClaimViolations([['k', 'SSO']], 'en', now, [ok], { [proof]: 'fail' }),
    ).toHaveLength(1);
  });
});
