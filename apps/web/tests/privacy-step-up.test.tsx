import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { MyDataScreen } from '../src/components/screens/MyDataScreen';
import { PrivacyScreen } from '../src/components/screens/PrivacyScreen';
import type { MyPrivacyView, PrivacyOverviewView } from '../src/lib/api/privacy';

/**
 * S13 / F28: the export and deletion requests need fresh proof. A 403 `reauthentication_required`
 * opens "Confirm it's you"; the password goes to `POST /v1/auth/reauth`, and the same request is
 * made again with the returned token in `x-reauth-token`.
 */

const NOW = new Date('2026-10-25T13:30:00.000Z');

interface Call {
  method: string;
  url: string;
  body: string | null;
  reauth: string | null;
}

const overview: PrivacyOverviewView = {
  organizationName: 'Northstar Studio',
  memberCount: 24,
  gracePeriodDays: 30,
  linkDays: 7,
  companyExports: [],
  memberExports: [],
  members: [],
  deletion: null,
};

const mine: MyPrivacyView = {
  organizationName: 'Northstar Studio',
  gracePeriodDays: 30,
  linkDays: 7,
  export: null,
  deletion: null,
};

const stepUpRefusal = {
  status: 403,
  body: {
    error: {
      code: 'reauthentication_required',
      message: 'Confirm your password to continue.',
      correlationId: 'c',
    },
  },
};

function mount(
  ui: (client: ApiClient) => ReactElement,
  routes: (call: Call) => { status: number; body?: unknown },
) {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : null,
        reauth: new Headers(init?.headers).get('x-reauth-token'),
      };
      calls.push(call);
      const { status, body } = routes(call);
      return Promise.resolve(
        new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={query}>{ui(client)}</QueryClientProvider>);
  return calls;
}

async function confirmWithPassword(): Promise<void> {
  const dialog = await screen.findByRole('dialog', { name: 'Confirm it’s you' });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse' } });
  const confirm = Array.from(dialog.querySelectorAll('button')).find(
    (node) => node.textContent === 'Confirm',
  ) as HTMLButtonElement;
  fireEvent.click(confirm);
}

describe('Privacy page — step-up before an export', () => {
  it('asks for the password on a step-up refusal, then retries with the token', async () => {
    const calls = mount(
      (client) => (
        <PrivacyScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
          baseUrl="https://api.example.test"
          now={() => NOW}
        />
      ),
      (call) => {
        if (call.url.endsWith('/v1/auth/reauth')) {
          return {
            status: 200,
            body: { reauthToken: 'fresh-proof', expiresAt: NOW.toISOString() },
          };
        }
        if (call.url.endsWith('/admin/privacy/exports')) {
          return call.reauth === 'fresh-proof' ? { status: 201, body: overview } : stepUpRefusal;
        }
        return { status: 200, body: overview };
      },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Request export' }));
    const exportDialog = await screen.findByRole('dialog', { name: 'Export all company data?' });
    const start = Array.from(exportDialog.querySelectorAll('button')).find(
      (node) => node.textContent === 'Start export',
    ) as HTMLButtonElement;
    fireEvent.click(start);
    await confirmWithPassword();
    await waitFor(() =>
      expect(
        calls.filter((call) => call.url.endsWith('/admin/privacy/exports')).map((c) => c.reauth),
      ).toEqual([null, 'fresh-proof']),
    );
    const reauth = calls.find((call) => call.url.endsWith('/v1/auth/reauth'));
    expect(reauth?.body).toBe(JSON.stringify({ password: 'correct horse' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('My data — step-up before an export', () => {
  it('retries the export with the proof once the password is confirmed', async () => {
    const calls = mount(
      (client) => (
        <MyDataScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
          baseUrl="https://api.example.test"
          now={() => NOW}
        />
      ),
      (call) => {
        if (call.url.endsWith('/v1/auth/reauth')) {
          return {
            status: 200,
            body: { reauthToken: 'fresh-proof', expiresAt: NOW.toISOString() },
          };
        }
        if (call.url.endsWith('/me/privacy/exports')) {
          return call.reauth === 'fresh-proof' ? { status: 201, body: mine } : stepUpRefusal;
        }
        return { status: 200, body: mine };
      },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Request my data' }));
    await confirmWithPassword();
    await waitFor(() =>
      expect(
        calls.filter((call) => call.url.endsWith('/me/privacy/exports')).map((c) => c.reauth),
      ).toEqual([null, 'fresh-proof']),
    );
  });
});
