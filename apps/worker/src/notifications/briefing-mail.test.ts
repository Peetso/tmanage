import { describe, expect, it } from 'vitest';
import type { BriefingLine } from '@tmanage/domain';
import { briefingReasonText, briefingSectionParagraphs } from './briefing-mail.js';

/**
 * The briefing section of the digest mail says the card's words: the group named for what it
 * lists (T4 F3) and every counted reason in the language's plural form (T4 F5).
 */

const line = (patch: Partial<BriefingLine>): BriefingLine => ({
  signalId: 's1',
  rule: 'deadline_at_risk',
  subjectType: 'work_item',
  subjectId: 'w1',
  projectId: 'p1',
  measure: -2,
  threshold: 5,
  title: 'Launch kit',
  context: 'Cedar Foods brand refresh',
  amount: null,
  category: null,
  deliverableId: null,
  path: '/work/w1',
  ...patch,
});

describe('briefing mail words', () => {
  it('Arabic days agree with the number: one, two, 3–10, 11+', () => {
    const late = (measure: number) => briefingReasonText(line({ measure }), 'ar');
    expect(late(-1)).toBe('تجاوز موعده بيوم، والعمل ما زال مفتوحًا');
    expect(late(-2)).toBe('تجاوز موعده بيومين، والعمل ما زال مفتوحًا');
    expect(late(-3)).toBe('تجاوز موعده بـ3 أيام، والعمل ما زال مفتوحًا');
    expect(late(-46)).toBe('تجاوز موعده بـ46 يومًا، والعمل ما زال مفتوحًا');
    const overdue = (measure: number) =>
      briefingReasonText(
        line({ rule: 'overdue_invoice', subjectType: 'client_invoice', measure }),
        'ar',
      );
    expect(overdue(12)).toBe('متأخرة 12 يومًا');
    expect(overdue(2)).toBe('متأخرة يومين');
  });

  it('English says one day in words and the rest as a number', () => {
    expect(briefingReasonText(line({ measure: -1 }), 'en')).toBe(
      'One day past due, work still open',
    );
    expect(briefingReasonText(line({ measure: -45 }), 'en')).toBe(
      '45 days past due, work still open',
    );
  });

  it('names the deadline group for the late or at-risk tasks it lists', () => {
    const section = {
      audience: 'company' as const,
      asOf: new Date('2026-11-19T08:00:00.000Z'),
      timezone: 'UTC',
      homeLink: 'https://app.example.test/northstar',
      groups: [
        {
          group: 'projects_at_risk' as const,
          count: 1,
          lines: [line({})],
          more: 0,
          path: '/projects/portfolio',
          link: 'https://app.example.test/northstar/projects/portfolio',
        },
      ],
    };
    expect(briefingSectionParagraphs(section, 'en')[2]).toMatch(/^Late or at-risk tasks \(1\)/u);
    expect(briefingSectionParagraphs(section, 'ar')[2]).toContain(
      'مهام متأخرة أو معرّضة للتأخير (1)',
    );
  });
});
