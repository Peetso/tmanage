import { describe, expect, it } from 'vitest';
import { measuresFor, medianBucket } from '../src/lib/api/ease-scoreboard';
import type { EaseScoreboardView } from '../src/lib/api/ease-scoreboard';

const count = (eventName: string, locale: string, events: number) => ({
  week: '2026-W43',
  eventName,
  locale,
  principalKind: 'internal',
  events,
  actors: events,
  organizations: 1,
});
const view: EaseScoreboardView = {
  since: '2026-09-01T00:00:00.000Z',
  weeks: 8,
  kAnonymityFloor: 5,
  counts: [
    count('help_article_viewed_v1', 'en', 20),
    count('support_conversation_opened_v1', 'en', 5),
    count('onboarding_completed_v1', 'ar-EG', 10),
    count('first_project_created_v1', 'ar-EG', 6),
  ],
  timers: [
    {
      week: '2026-W43',
      eventName: 'first_project_created_v1',
      locale: 'ar',
      bucket: '1_3m',
      events: 5,
    },
    {
      week: '2026-W43',
      eventName: 'first_project_created_v1',
      locale: 'ar',
      bucket: '3_10m',
      events: 6,
    },
  ],
};

describe('55-21 ease scoreboard derivations', () => {
  it('reads the median bucket, deflection and activation per language', () => {
    expect(medianBucket(view, 'first_project_created_v1', '2026-W43', 'all')).toBe('3_10m');
    expect(measuresFor(view, '2026-W43', 'en').helpDeflection).toBe(75);
    expect(measuresFor(view, '2026-W43', 'ar').activation).toBe(60);
    expect(measuresFor(view, '2026-W43', 'en').timeToFirstProject).toBeNull();
  });
});
