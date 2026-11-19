import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DigestPreferenceScreen } from '../src/components/screens/DigestPreferenceScreen';
import { ApiClient } from '../src/lib/api/client';
import type { HomeBriefing } from '../src/lib/api/home-briefing';
import { BRIEFING_NONE, BRIEFING_OWNER } from '../stories/support/briefing-fixtures';

vi.mock('next/navigation', () => ({
  usePathname: () => '/northstar/settings/digest',
  useRouter: () => ({ push: vi.fn() }),
}));

/**
 * 62-A1c (B12) — the per-person switch that adds the business briefing to the digest mail: off by
 * default, offered only to someone who has a briefing (the Home card's read), saved with the rest
 * of the digest settings.
 */

function client(briefing: HomeBriefing | null, writes: unknown[]): ApiClient {
  const reply = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
    if (path.endsWith('/home/briefing')) {
      return briefing === null
        ? reply({ error: { code: 'not_found', message: 'x', correlationId: 'c' } }, 404)
        : reply(briefing);
    }
    if (path.endsWith('/preferences/digest')) {
      if (init?.method === 'PUT') {
        const body: unknown = JSON.parse(String(init.body));
        writes.push(body);
        return reply(body);
      }
      return reply({ cadence: 'daily', sendHour: 8, dayOfWeek: 1, businessBriefing: false });
    }
    return reply({});
  }) as typeof globalThis.fetch;
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
}

function mount(briefing: HomeBriefing | null) {
  const writes: unknown[] = [];
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <DigestPreferenceScreen
        organizationSlug="northstar"
        organizationName="Atlas Studio"
        client={client(briefing, writes)}
      />
    </QueryClientProvider>,
  );
  return writes;
}

describe('digest settings: the business briefing switch (62-A1c)', () => {
  it('is offered off to someone with a briefing, and saved with the digest', async () => {
    const writes = mount(BRIEFING_OWNER);
    const toggle = await screen.findByRole('switch', { name: 'Add the business briefing' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      cadence: 'daily',
      sendHour: 8,
      dayOfWeek: 1,
      businessBriefing: true,
    });
  });

  it.each([
    ['the flag is off, a client or a guest (404)', null],
    ['a member who leads nothing', BRIEFING_NONE],
  ] as const)('is not offered when %s', async (_name, briefing) => {
    mount(briefing);
    await screen.findByRole('radio', { name: /daily/i });
    await waitFor(() => expect(screen.queryByRole('switch')).toBeNull());
  });
});
