import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  effectiveMeetingDefaults,
  FALLBACK_DEFAULTS,
} from '../src/components/meetings/meeting-defaults';
import { refreshCalendarQueries } from '../src/components/meetings/CalendarConnections';

/**
 * FIX2 (live 2026-11-09, Settings > Calendar connections): after Google Calendar was
 * disconnected, "New meetings go to" showed Outlook while "Video call" stayed on Google Meet,
 * and the owners' team card still listed the person as connected to Google Calendar.
 */
describe('calendar connection defaults', () => {
  it('moves the video call to Teams when the destination falls back to Outlook', () => {
    const saved = {
      ...FALLBACK_DEFAULTS,
      provider: 'google' as const,
      conference: 'google_meet' as const,
    };
    expect(effectiveMeetingDefaults(saved, ['microsoft'])).toMatchObject({
      provider: 'microsoft',
      conference: 'teams',
    });
  });

  it('never pairs a destination with the other provider’s video call', () => {
    const mismatched = {
      ...FALLBACK_DEFAULTS,
      provider: 'google' as const,
      conference: 'teams' as const,
    };
    expect(effectiveMeetingDefaults(mismatched, ['google', 'microsoft'])).toMatchObject({
      provider: 'google',
      conference: 'google_meet',
    });
  });

  it('keeps "No video call" and a still-connected choice', () => {
    const none = {
      ...FALLBACK_DEFAULTS,
      provider: 'microsoft' as const,
      conference: 'none' as const,
    };
    expect(effectiveMeetingDefaults(none, ['google', 'microsoft'])).toMatchObject({
      provider: 'microsoft',
      conference: 'none',
    });
  });

  it('refreshes the team card along with the own connections after a change', async () => {
    const queries = new QueryClient();
    queries.setQueryData(['calendar-team', 'acme'], { connections: [] });
    queries.setQueryData(['calendar-connection', 'acme', 'google'], { configured: true });
    queries.setQueryData(['calendar-team', 'other'], { connections: [] });
    refreshCalendarQueries(queries, 'acme');
    expect(queries.getQueryState(['calendar-team', 'acme'])?.isInvalidated).toBe(true);
    expect(queries.getQueryState(['calendar-connection', 'acme', 'google'])?.isInvalidated).toBe(
      true,
    );
    expect(queries.getQueryState(['calendar-team', 'other'])?.isInvalidated).toBe(false);
  });
});
