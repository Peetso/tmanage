import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { PricingSurveyCard } from '../src/components/screens/PricingSurveyCard';
import { ApiClient } from '../src/lib/api/client';

/** 57-17 WTP — the willingness-to-pay card on Home. */

function clientWith(routes: (method: string, url: string) => { status: number; body: unknown }) {
  const calls: { method: string; url: string; body: string | null }[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : null });
      const { status, body } = routes(method, url);
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  return { client, calls };
}

function wrap(node: ReactNode) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={query}>{node}</QueryClientProvider>);
}

const BASE = 'https://api.example.test/v1/organizations/northstar/pricing-survey';

describe('PricingSurveyCard (57-17 WTP)', () => {
  it('draws nothing when the API says not to show it, or when the read is refused', async () => {
    for (const reply of [
      { status: 200, body: { show: false } },
      { status: 403, body: { error: { code: 'forbidden', message: 'No', correlationId: 'c' } } },
    ]) {
      const { client, calls } = clientWith(() => reply);
      const { container, unmount } = wrap(
        <PricingSurveyCard api={client} organizationSlug="northstar" />,
      );
      await waitFor(() => expect(calls.length).toBe(1));
      expect(container.textContent).toBe('');
      unmount();
    }
  });

  it('keeps "Send answer" disabled until a band is chosen, then sends band and note', async () => {
    const { client, calls } = clientWith((method) =>
      method === 'POST'
        ? { status: 200, body: { show: false, outcome: 'answered' } }
        : { status: 200, body: { show: true } },
    );
    wrap(<PricingSurveyCard api={client} organizationSlug="northstar" />);
    const send = await screen.findByRole('button', { name: 'Send answer' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: '$5–$9' }));
    expect(screen.getByRole('radio', { name: '$5–$9' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.change(screen.getByLabelText('Anything to add? (optional)'), {
      target: { value: ' Fair for a small team ' },
    });
    expect((send as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(send);
    expect(await screen.findByText('Thank you. Your answer is saved.')).toBeTruthy();
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.url).toBe(`${BASE}/answer`);
    expect(JSON.parse(post?.body ?? '{}')).toEqual({ band: '5_9', note: 'Fair for a small team' });
  });

  it('hides the card at once on Skip', async () => {
    const { client, calls } = clientWith((method) =>
      method === 'POST'
        ? { status: 200, body: { show: false, outcome: 'skipped' } }
        : { status: 200, body: { show: true } },
    );
    wrap(<PricingSurveyCard api={client} organizationSlug="northstar" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Skip' }));
    await waitFor(() =>
      expect(screen.queryByText('What would you pay per person each month?')).toBeNull(),
    );
    expect(calls.map((call) => `${call.method} ${call.url}`)).toContain(`POST ${BASE}/skip`);
  });
});
