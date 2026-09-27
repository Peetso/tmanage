import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { PreferencesScreen } from '../src/components/screens/PreferencesScreen';
import { expectNoAxeViolations } from './axe';

/** PREF-001 appearance & accessibility (x182) — the preferences read/edit screen. */
function mount(body: unknown, status = 200) {
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={query}>
      <PreferencesScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        client={client}
      />
    </QueryClientProvider>,
  );
}

const PREFS = { theme: 'dark', locale: 'fr', density: 'compact' };

describe('PreferencesScreen', () => {
  it('renders the appearance form seeded from the server, and is axe-clean', async () => {
    const { container } = mount(PREFS);

    const theme = (await screen.findByLabelText('Theme')) as HTMLSelectElement;
    expect(theme.value).toBe('dark');
    expect((screen.getByLabelText('Language') as HTMLSelectElement).value).toBe('fr');
    expect((screen.getByLabelText('Density') as HTMLSelectElement).value).toBe('compact');
    expect(screen.getByRole('button', { name: 'Save preferences' })).toBeTruthy();

    await expectNoAxeViolations(container);
  });

  it('renders the API refusal rather than a blank page', async () => {
    mount({ error: { code: 'forbidden', message: 'No access.', correlationId: 'c' } }, 403);
    await waitFor(() => expect(screen.getByText('No access.')).toBeTruthy());
  });
});
