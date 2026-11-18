import { describe, expect, it } from 'vitest';
import { ACTIVITY_ACTIONS } from '@tmanage/domain';
import { activityPhrase } from './activity-phrases.js';

/** 62-A2 (B02) — every catalogued action has its own words, built from the action alone. */

describe('activity phrases (62-A2)', () => {
  it.each(ACTIVITY_ACTIONS)('%s has a catalogue key and an English phrase', (action) => {
    const phrase = activityPhrase(action);
    expect(phrase.phraseKey).toBe(`activity.phrase.${action}`);
    expect(phrase.summary).toMatch(/^[A-Z][A-Za-z' ]+$/);
    expect(phrase.summary).not.toContain(action);
  });

  it('no two actions share a phrase, so the tab never reads the same for different things', () => {
    const summaries = ACTIVITY_ACTIONS.map((action) => activityPhrase(action).summary);
    expect(new Set(summaries).size).toBe(summaries.length);
  });
});
