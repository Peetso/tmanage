import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  GettingStartedCard,
  GettingStartedLauncher,
  inlineShiftIntoViewport,
  shouldOfferChecklist,
} from '../src/components/onboarding/GettingStartedCard';
import { ApiClient } from '../src/lib/api/client';
import type { GettingStartedView } from '../src/lib/api/getting-started';

vi.mock('../src/components/shell/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const { SettingsHomeScreen } = await import('../src/components/screens/SettingsHomeScreen');

/** 55-11 checklist card and 55-22 Settings home with the owner's Setup health. */

function checklist(over: Partial<GettingStartedView> = {}): GettingStartedView {
  return {
    dismissed: false,
    completedCount: 2,
    totalCount: 6,
    nextStep: 'add_client',
    steps: [
      { step: 'invite_teammate', done: true },
      { step: 'create_project', done: true },
      { step: 'add_client', done: false },
      { step: 'connect_storage', done: false },
      { step: 'set_working_hours', done: false },
      { step: 'try_ai_assistant', done: false },
    ],
    ...over,
  };
}

function clientWith(routes: (method: string, url: string) => { status: number; body: unknown }) {
  const calls: string[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      calls.push(`${method} ${url}`);
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

describe('GettingStartedCard (55-11)', () => {
  it('shows progress, links the next step, and hides after "Hide checklist"', async () => {
    const { client, calls } = clientWith((method, url) =>
      method === 'POST' && url.endsWith('/dismiss')
        ? { status: 200, body: checklist({ dismissed: true }) }
        : { status: 200, body: checklist() },
    );
    wrap(<GettingStartedCard organizationSlug="northstar" client={client} />);
    expect(await screen.findByText('2 of 6 done')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Start' }).getAttribute('href')).toBe(
      '/northstar/clients',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Hide checklist' }));
    await waitFor(() => expect(screen.queryByText('Getting started')).toBeNull());
    expect(calls).toContain(
      'POST https://api.example.test/v1/organizations/northstar/getting-started/dismiss',
    );
  });

  it('marks a step done by hand', async () => {
    const { client, calls } = clientWith(() => ({ status: 200, body: checklist() }));
    wrap(<GettingStartedCard organizationSlug="northstar" client={client} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark done: Add a client' }));
    await waitFor(() =>
      expect(calls).toContain(
        'POST https://api.example.test/v1/organizations/northstar/getting-started/steps/add_client/complete',
      ),
    );
  });

  it('is not offered once dismissed or finished', () => {
    expect(shouldOfferChecklist(checklist({ dismissed: true }))).toBe(false);
    expect(shouldOfferChecklist(checklist({ completedCount: 6 }))).toBe(false);
    expect(shouldOfferChecklist(undefined)).toBe(false);
  });
});

describe('GettingStartedLauncher popover stays in the window (FIX5 item 6a, B-N6)', () => {
  it('slides a popover that starts off the left edge back inside, and one off the right edge too', () => {
    // 440px panel hanging off a capsule near the left edge: starts at -300 -> pinned at 16.
    expect(inlineShiftIntoViewport(-300, 440, 1280)).toBe(316);
    // Already inside: no shift.
    expect(inlineShiftIntoViewport(600, 440, 1280)).toBe(0);
    // RTL: the panel hangs off the capsule's left, so it can run off the right edge.
    expect(inlineShiftIntoViewport(1000, 440, 1280)).toBe(1280 - 16 - 440 - 1000);
    // Wider than the window: pinned to the left gutter.
    expect(inlineShiftIntoViewport(-50, 500, 400)).toBe(66);
  });

  it('applies the shift to the open panel', async () => {
    const { client } = clientWith(() => ({ status: 200, body: checklist() }));
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function rect(this: HTMLElement) {
      const left = this.classList.contains('tm-gs-launch__panel') ? -300 : 0;
      return {
        left,
        right: left + 440,
        width: 440,
        top: 0,
        bottom: 400,
        height: 400,
        x: left,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    };
    try {
      wrap(<GettingStartedLauncher organizationSlug="northstar" client={client} />);
      fireEvent.click(await screen.findByRole('button', { name: /Getting started 2\/6/ }));
      const panel = document.querySelector<HTMLElement>('.tm-gs-launch__panel');
      expect(panel?.style.transform).toBe('translateX(316px)');
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });
});

describe('SettingsHomeScreen (55-22)', () => {
  it('shows Setup health with fix links for an owner', async () => {
    const { client } = clientWith((_m, url) =>
      url.endsWith('/setup-health')
        ? {
            status: 200,
            body: {
              okCount: 1,
              checks: [
                { check: 'storage', ok: true },
                { check: 'sign_in_security', ok: false },
                { check: 'backups', ok: false },
                { check: 'domain_mail', ok: false },
              ],
            },
          }
        : { status: 200, body: checklist() },
    );
    wrap(
      <SettingsHomeScreen
        organizationSlug="northstar"
        organizationName="Northstar"
        client={client}
      />,
    );
    expect(await screen.findByText('Setup health')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Require two-step' }).getAttribute('href')).toBe(
      '/northstar/settings/organization',
    );
    expect(screen.getByRole('link', { name: 'Organization policy' })).toBeTruthy();
  });

  it('hides Setup health from a member the API refuses', async () => {
    const { client } = clientWith((_m, url) =>
      url.endsWith('/setup-health')
        ? { status: 403, body: { error: { code: 'forbidden', message: 'Forbidden' } } }
        : { status: 200, body: checklist() },
    );
    wrap(
      <SettingsHomeScreen
        organizationSlug="northstar"
        organizationName="Northstar"
        client={client}
      />,
    );
    expect(await screen.findByText('2 of 6 done')).toBeTruthy();
    expect(screen.queryByText('Setup health')).toBeNull();
  });
});
