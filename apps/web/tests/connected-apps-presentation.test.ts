import { describe, expect, it } from 'vitest';
import {
  appMonograms,
  formatConnectedDate,
  formatLastUsed,
  scopeLabelKey,
} from '../src/lib/connected-apps-presentation';

/** S11 Connected apps (Figma S0-2): the monograms, chips and dates the design draws. */
describe('connected apps presentation', () => {
  it('draws one unique monogram per app, as the design does', () => {
    expect(appMonograms(['Claude', 'ChatGPT', 'Cursor', 'Field notes bot'])).toEqual([
      'C',
      'G',
      'Cu',
      'F',
    ]);
  });

  it('labels the known scopes and draws nothing for one it cannot explain', () => {
    expect(scopeLabelKey('tmanage:manage')).toBe('ConnectedApps.scopeManage');
    expect(scopeLabelKey('tmanage:unknown')).toBeUndefined();
  });

  it('writes dates and last use in the frame wording, with Latin digits in Arabic', () => {
    const now = new Date('2026-10-22T12:00:00.000Z');
    expect(formatConnectedDate('2026-07-12T09:00:00.000Z', 'en-US')).toBe('12 Jul 2026');
    expect(formatConnectedDate('2026-07-12T09:00:00.000Z', 'ar-EG')).toBe('12 يوليو 2026');
    expect(formatLastUsed('2026-10-22T11:58:00.000Z', now, 'en-US')).toBe('2 minutes ago');
    expect(formatLastUsed('2026-10-21T08:00:00.000Z', now, 'en-US')).toBe('yesterday');
    expect(formatLastUsed('2026-10-18T10:00:00.000Z', now, 'en-US')).toBe('4 days ago');
    expect(formatLastUsed('2026-10-18T10:00:00.000Z', now, 'ar-EG')).toBe('قبل 4 أيام');
  });
});
