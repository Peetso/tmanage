import { describe, expect, it } from 'vitest';
import type { BriefingLine } from './briefing.js';
import {
  DIGEST_WORDING_MAX_CHARS,
  checkDigestWording,
  digestLinesKey,
  digestSectionLines,
  digestWordingFacts,
  renderDigestWording,
} from './digest-wording.js';
import { SIGNAL_RULES } from './signal-catalog.js';
import type { SignalRuleKey } from './signal-catalog.js';

function line(rule: SignalRuleKey, patch: Partial<BriefingLine> = {}): BriefingLine {
  return {
    signalId: `sig-${rule}`,
    rule,
    subjectType: SIGNAL_RULES[rule].subjectType,
    subjectId: `s-${rule}`,
    projectId: 'p1',
    measure: 10,
    threshold: 7,
    title: null,
    context: null,
    amount: null,
    category: null,
    deliverableId: null,
    path: '/work',
    ...patch,
  };
}

const LINES: readonly BriefingLine[] = [
  line('overdue_invoice', {
    signalId: 'A1',
    measure: 12,
    title: 'INV-0038',
    context: 'Cedar Foods',
    amount: { minor: 420_000, currency: 'USD' },
  }),
  line('stale_task', { signalId: 'B2', measure: 16, threshold: 14, title: 'Footer redesign' }),
  line('overloaded_person', { signalId: 'C3', measure: 115, threshold: 100, title: 'Omar Adel' }),
];

const GOOD =
  'Cedar Foods still owes $4,200 on [1], now 12 days overdue. ' +
  '[2] has not moved for 16 days, and [3] is planned at 115% of capacity.';

describe('digest wording rules (62-28)', () => {
  it('the facts carry the figures of each line and no id or link', () => {
    const facts = digestWordingFacts(LINES);
    expect(facts.map((f) => f.n)).toEqual([1, 2, 3]);
    expect(facts[0]).toMatchObject({
      rule: 'overdue_invoice',
      record: 'INV-0038',
      context: 'Cedar Foods',
      figures: { days: 12 },
      amount: '4200.00 USD',
    });
    expect(facts[2]?.figures).toEqual({ percent: 115 });
    const json = JSON.stringify(facts);
    expect(json).not.toContain('A1');
    expect(json).not.toContain('/work');
  });

  it('the key is the shown ids in order, and a section is its groups in order', () => {
    expect(digestLinesKey(LINES)).toBe('a1,b2,c3');
    expect(digestLinesKey([...LINES].reverse())).not.toBe(digestLinesKey(LINES));
    const groups = [
      { group: 'money' as const, count: 1, lines: LINES.slice(0, 1), more: 0, path: '/f' },
      { group: 'work' as const, count: 2, lines: LINES.slice(1), more: 0, path: '/w' },
    ];
    expect(digestSectionLines(groups)).toEqual(LINES);
  });

  it('a wording that cites every fact with their own figures passes', () => {
    expect(checkDigestWording(GOOD, LINES)).toEqual({ ok: true, text: GOOD });
  });

  it.each([
    ['', 'empty'],
    ['x'.repeat(DIGEST_WORDING_MAX_CHARS + 1), 'too_long'],
    [`${GOOD} <b>now</b>`, 'markup'],
    [`${GOOD} **Act**`, 'markup'],
    [`${GOOD} See https://evil.example`, 'link'],
    [`${GOOD} Write to a@b.c`, 'link'],
    [`${GOOD} Also [4].`, 'unknown_fact'],
    ['[1] is 12 days overdue and [2] has not moved for 16 days.', 'missing_fact'],
    [GOOD.replace('16 days', '19 days'), 'invented_figure'],
    [GOOD.replace('$4,200', '$5,000'), 'invented_figure'],
  ])('rejects %#: %s', (text, reason) => {
    expect(checkDigestWording(text, LINES)).toEqual({ ok: false, reason });
  });

  it('rejects a control or direction character', () => {
    const rlo = String.fromCodePoint(0x202e);
    expect(checkDigestWording(`${GOOD}${rlo}`, LINES)).toEqual({ ok: false, reason: 'markup' });
  });

  it('render puts the record names where the numbers were', () => {
    expect(renderDigestWording(GOOD, LINES)).toBe(
      'Cedar Foods still owes $4,200 on INV-0038, now 12 days overdue. ' +
        'Footer redesign has not moved for 16 days, and Omar Adel is planned at 115% of capacity.',
    );
  });
});
