import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { DisplayPreferencesView } from '../src/components/screens/DisplayPreferencesView';
import { LocaleDirectionProvider } from '../src/components/providers/LocaleDirectionProvider';
import { activeLocale } from '../src/lib/i18n/locale-store';

// The shell's ThemeSync reads the same `['display-preferences', slug]` query through the browser
// client; here the screen's own test client must be the one that answers it.
vi.mock('../src/components/shell/ThemeSync', () => ({ ThemeSync: () => null }));

/** PREF-02 Appearance: the saved theme on first paint, no second language picker, density applied. */
const SAVED = {
  theme: 'dark',
  density: 'comfortable',
  locale: 'en-US',
  timezone: 'UTC',
  dateFormat: 'iso',
};

interface Call {
  method: string;
  body: unknown;
}

function mount() {
  const calls: Call[] = [];
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, body });
    const payload = String(input).endsWith('/me/display-preferences')
      ? method === 'PUT'
        ? body
        : SAVED
      : {};
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof globalThis.fetch;
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={query}>
      <LocaleDirectionProvider>
        <DisplayPreferencesView
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
        />
      </LocaleDirectionProvider>
    </QueryClientProvider>,
  );
  return calls;
}

afterEach(() => {
  activeLocale.set('en-US');
  document.documentElement.dataset['density'] = 'balanced';
});

describe('DisplayPreferencesView (PREF-02)', () => {
  it('shows the saved theme as soon as the form appears, never "Match system" first', async () => {
    mount();
    const dark = (await screen.findByLabelText('Dark')) as HTMLInputElement;
    expect(dark.checked).toBe(true);
    expect((screen.getByLabelText('Match system') as HTMLInputElement).checked).toBe(false);
  });

  it('R12: offers the nine languages by their own names, betas marked, ja-JP hidden', async () => {
    mount();
    const select = await screen.findByLabelText('Language');
    const options = Array.from((select as HTMLSelectElement).options).map((o) => o.textContent);
    expect(options).toHaveLength(9);
    expect(options).toContain('Español · Beta');
    expect(options).toContain('اردو · Beta');
    expect(screen.queryByRole('option', { name: 'ja-JP' })).toBeNull();
  });

  it('saving Compact sends the saved locale back and tightens the app density', async () => {
    const calls = mount();
    fireEvent.click(await screen.findByLabelText('Compact'));
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(document.documentElement.dataset['density']).toBe('operational'));
    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
      ...SAVED,
      density: 'compact',
      numerals: 'latin',
      weekStart: 'monday',
    });
  });

  it('C24: picking Power, Arabic-Indic and Saturday sends them as the member own choice', async () => {
    const calls = mount();
    fireEvent.click(await screen.findByLabelText('Power'));
    fireEvent.click(screen.getByLabelText(/Arabic-Indic/));
    fireEvent.click(screen.getByLabelText('Saturday'));
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    expect(calls.find((call) => call.method === 'PUT')?.body).toMatchObject({
      uiMode: 'power',
      numerals: 'arabic_indic',
      weekStart: 'saturday',
    });
  });
});
