import { describe, expect, it } from 'vitest';
import { buildRrule, parseRrule, windowOf } from '../src/components/meetings/meeting-model';
import { readCalendarReturn } from '../src/lib/api/calendar-connections';
import { ApiClient } from '../src/lib/api/client';
import { listMeetingsInWindow } from '../src/lib/api/meetings';

/**
 * The calendar reads one org-wide window (`GET /meetings?from&to`, no projectId) instead of a
 * per-project scan; the repeat menu writes the RRULE body the API takes; the settings page reads
 * the connect callback's fragment.
 */

describe('meetings web model', () => {
  it('reads the whole org in one window, without a projectId', async () => {
    const urls: string[] = [];
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((input: RequestInfo | URL) => {
        urls.push(String(input));
        return Promise.resolve(new Response('{"meetings":[]}', { status: 200 }));
      }) as typeof globalThis.fetch,
      readCsrfToken: () => 'csrf-token',
      newCorrelationId: () => 'correlation-fixed',
    });
    const span = windowOf('week', new Date(2026, 9, 28, 10));
    await listMeetingsInWindow(client, 'acme', span);
    const url = new URL(urls[0] ?? '');
    expect(url.pathname).toBe('/v1/organizations/acme/meetings');
    expect(url.searchParams.get('projectId')).toBeNull();
    expect(new Date(url.searchParams.get('from') ?? '').getDay()).toBe(1);
    expect(new Date(span.to).getDay()).toBe(1); // the next Monday, DST-safe
  });

  it('round-trips the repeat rule the form writes', () => {
    const rule = {
      freq: 'WEEKLY',
      interval: 2,
      byDay: ['MO', 'WE'],
      until: '2026-12-21',
      count: null,
    } as const;
    expect(buildRrule(rule)).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261221T235959Z');
    expect(parseRrule(buildRrule(rule))).toEqual(rule);
  });

  it('reads the Google and Microsoft connect callbacks', () => {
    expect(readCalendarReturn('#gcal=complete&code=c1&state=s1')).toEqual({
      kind: 'complete',
      provider: 'google',
      code: 'c1',
      state: 's1',
    });
    expect(readCalendarReturn('#mscal=error')).toEqual({ kind: 'error', provider: 'microsoft' });
    expect(readCalendarReturn('')).toBeNull();
  });
});
