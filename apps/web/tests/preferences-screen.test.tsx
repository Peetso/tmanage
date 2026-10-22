import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { PreferencesScreen } from '../src/components/screens/PreferencesScreen';
import { LocaleDirectionProvider } from '../src/components/providers/LocaleDirectionProvider';
import { activeLocale } from '../src/lib/i18n/locale-store';

// The Profile.* strings land in the catalogs from this slice's i18n fragment; until the merge, the
// ones these tests read by name are supplied here (a no-op once the catalog has them).
vi.mock('../src/lib/i18n/messages/en.json', async (importOriginal) => {
  const original = (await importOriginal<{ default: Record<string, string> }>()).default;
  return {
    default: {
      'Profile.fullName': 'Full name',
      'Profile.signInEmail': 'Sign-in email',
      'Profile.jobTitle': 'Job title',
      'Profile.timeZone': 'Time zone',
      'Profile.save': 'Save changes',
      'Profile.on': 'On',
      'Profile.off': 'Off',
      'Profile.turnOn': 'Turn on',
      'Profile.manage': 'Manage',
      ...original,
    },
  };
});

/** t2-b Profile & preferences: profile, the one language setting, time zone, two-step, password. */
const PROFILE = {
  displayName: 'Omar Adel',
  email: 'omar@northstar.studio',
  jobTitle: 'Project lead',
};
const DISPLAY = {
  theme: 'system',
  density: 'comfortable',
  locale: 'en-US',
  timezone: 'Europe/London',
  dateFormat: 'iso',
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function mount(factors: unknown[] = []) {
  const calls: Call[] = [];
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path: url.pathname, body });
    let payload: unknown = {};
    if (url.pathname.endsWith('/me/profile')) payload = method === 'PUT' ? body : PROFILE;
    else if (url.pathname.endsWith('/me/display-preferences'))
      payload = method === 'PUT' ? body : DISPLAY;
    else if (url.pathname === '/v1/auth/factors') payload = { factors, recoveryCodesRemaining: 0 };
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
        <PreferencesScreen
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
});

describe('PreferencesScreen (t2-b)', () => {
  it('loads the profile and the language / time zone', async () => {
    mount();
    expect(((await screen.findByLabelText('Full name')) as HTMLInputElement).value).toBe(
      'Omar Adel',
    );
    const email = screen.getByLabelText('Sign-in email') as HTMLInputElement;
    expect(email.value).toBe('omar@northstar.studio');
    expect(email.readOnly).toBe(true);
    expect((screen.getByLabelText('Job title') as HTMLInputElement).value).toBe('Project lead');
    expect((screen.getByLabelText('English') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Time zone') as HTMLSelectElement).value).toBe('Europe/London');
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Turn on' }).getAttribute('href')).toBe(
        '/northstar/settings/two-step',
      ),
    );
  });

  it('saving writes the profile and the display preferences', async () => {
    const calls = mount();
    fireEvent.change(await screen.findByLabelText('Full name'), {
      target: { value: 'Omar A. Adel' },
    });
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'Asia/Tokyo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(2));
    expect(
      calls.find((call) => call.path.endsWith('/me/profile') && call.method === 'PUT')?.body,
    ).toEqual({ displayName: 'Omar A. Adel', jobTitle: 'Project lead' });
    expect(
      calls.find((call) => call.path.endsWith('/me/display-preferences') && call.method === 'PUT')
        ?.body,
    ).toEqual({ ...DISPLAY, timezone: 'Asia/Tokyo' });
  });

  it('choosing Arabic flips the document to right-to-left after save, not before', async () => {
    mount();
    fireEvent.click(await screen.findByLabelText('العربية'));
    expect(document.documentElement.dir).not.toBe('rtl');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
    expect(activeLocale.get()).toBe('ar-EG');
  });

  it('the two-step row reflects the enrolled factors', async () => {
    mount([{ id: 'f1', kind: 'totp', label: 'Phone', confirmedAt: '2026-10-01T00:00:00Z' }]);
    await waitFor(() => expect(screen.getByTestId('two-step-state').textContent).toBe('On'));
    expect(screen.getByRole('link', { name: 'Manage' }).getAttribute('href')).toBe(
      '/northstar/settings/two-step',
    );
  });
});
