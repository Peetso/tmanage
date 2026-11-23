import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dayMonth } from '../src/components/billing/plan-usage-format';
import { dayLine, shortDate } from '../src/components/my-day/my-day-format';
import { shortDay } from '../src/components/projects/EditMilestoneDialog';
import { formatUpdateDay } from '../src/components/projects/UnpublishUpdateDialog';
import { formatChipDay } from '../src/components/work/DueDatePicker';
import { formatConnectedDate } from '../src/lib/connected-apps-presentation';
import { privacyDay } from '../src/lib/privacy-presentation';

/**
 * AR-DIGITS follow-up 2: My Day, the project dialogs, invitation, privacy, connected apps, triage,
 * subscription, the day pulse and the due-date picker wrote every non-Arabic locale as en-GB, so a
 * French or German member read "Fri 14 Nov". They now hand the member's own locale to
 * `appDateLocale`: English keeps the en-GB shape, Arabic keeps Latin digits, others get their own
 * day and month names.
 */

const DAY = '2026-11-14';
const AT = '2026-11-14T10:00:00.000Z';
const NOW = Date.parse('2026-11-14T12:00:00.000Z');

const ENGLISH_MONTH = /\bNov(ember)?\b/u;

describe('dates in the member’s language', () => {
  it.each([
    ['My Day due day', (l: string) => shortDate(l, AT, false)],
    ['My Day summary', (l: string) => dayLine(l, NOW)],
    ['milestone day', (l: string) => shortDay(DAY, l)],
    ['unpublish day', (l: string) => formatUpdateDay(DAY, l, true)],
    ['connected app day', (l: string) => formatConnectedDate(AT, l)],
    ['privacy day', (l: string) => privacyDay(AT, l, 'UTC')],
    ['due-date chip', (l: string) => formatChipDay(DAY, l)],
    ['plan renewal day', (l: string) => dayMonth(DAY, l)],
  ])('%s: French and German, not English; English and Arabic as before', (_name, format) => {
    const fr = format('fr-FR');
    const de = format('de-DE');
    expect(fr).toMatch(/nov(\.|embre)/u);
    expect(fr).not.toMatch(ENGLISH_MONTH);
    expect(de).toMatch(/Nov(\.|ember)/u);
    expect(de).not.toBe(format('en-GB'));
    expect(format('en-US')).toMatch(ENGLISH_MONTH);
    const ar = format('ar-EG');
    expect(ar).toMatch(/نوفمبر/u);
    expect(ar).not.toMatch(/[٠-٩]/u);
  });

  it('English keeps the en-GB order ("14 Nov", day first)', () => {
    expect(shortDate('en-US', AT, false)).toBe('14 Nov');
  });
});

/** No screen falls back to a fixed English tag for "anything not Arabic" again. */
describe('fitness: no "Arabic, else en-GB" date tags', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '../src');
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return /\.tsx?$/u.test(name) ? [path] : [];
    });
  }

  it('finds none in apps/web/src', () => {
    // `arabic ? locale : 'en-GB'` and `arabic ? 'ar' : 'en-GB'` alike.
    const pattern = /\?\s*(locale|'ar[-A-Za-z]*')\s*:\s*'en-GB'/u;
    const offenders = files(src)
      .filter((path) => pattern.test(readFileSync(path, 'utf8')))
      .map((path) => relative(src, path));
    expect(offenders).toEqual([]);
  });
});
