import { describe, expect, it } from 'vitest';
import { ACTIVITY_ACTIONS } from '@tmanage/domain';
import { activityPhrase } from './activity-phrases.js';

/** 62-A2 (B02), D2 — every catalogued action has its own words, and names its record when it can. */

describe('activity phrases (62-A2)', () => {
  it.each(ACTIVITY_ACTIONS)('%s has a catalogue key and an English phrase', (action) => {
    const phrase = activityPhrase(action);
    expect(phrase.phraseKey).toBe(`activity.phrase.${action}`);
    expect(phrase.summary).toMatch(/^[A-Z][A-Za-z' ]+$/);
    expect(phrase.summary).not.toContain(action);
    expect(phrase.subject).toBeNull();
  });

  it('no two actions share a phrase, so the tab never reads the same for different things', () => {
    const summaries = ACTIVITY_ACTIONS.map((action) => activityPhrase(action).summary);
    expect(new Set(summaries).size).toBe(summaries.length);
  });

  it('D2: names the record when it has a name ("Changed the status of “Packaging artwork”")', () => {
    expect(activityPhrase('work_item.transitioned', 'Packaging artwork')).toEqual({
      phraseKey: 'activity.subject.work_item.transitioned',
      summary: 'Changed the status of “Packaging artwork”',
      subject: 'Packaging artwork',
    });
    expect(activityPhrase('client_invoice.sent', 'INV-0042').summary).toBe('Sent invoice INV-0042');
    // A replacement pattern in a name is text, never a pattern.
    expect(activityPhrase('file_asset.uploaded', 'a $& b').summary).toBe('Uploaded “a $& b”');
  });

  it('D2: falls back to the generic phrase without a name, or for a source that has none', () => {
    expect(activityPhrase('work_item.created', null).phraseKey).toBe(
      'activity.phrase.work_item.created',
    );
    expect(activityPhrase('work_item.created', '').subject).toBeNull();
    expect(activityPhrase('expense.created', 'Taxi')).toEqual({
      phraseKey: 'activity.phrase.expense.created',
      summary: 'Added an expense',
      subject: null,
    });
  });
});
