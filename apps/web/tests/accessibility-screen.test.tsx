import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { AccessibilityScreen } from '../src/components/screens/AccessibilityScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * A11Y-183 accessibility preferences web (x183). The API's tenant scoping, the `work.read` gate and
 * the fixed-key allowlist are proved in the controller unit test (and, in the chain, the database
 * suite); nothing here re-proves them. What only this file can prove is what the *screen* does:
 *
 * - it reads the caller's preferences, seeds the form, and saves the chosen values back to
 *   `/me/accessibility` (PUT) with the whole settings object;
 * - the mounted document is axe-clean (A11Y-01).
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function clientOver(handler: (call: Call) => Response): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return Promise.resolve(handler(call));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const DEFAULTS = { fontScale: 'md', reduceMotion: false, highContrast: false };

describe('AccessibilityScreen (A11Y-183, x183)', () => {
  it('reads the preferences, then saves the chosen font size and reduced-motion back', async () => {
    const { client, calls } = clientOver((call) => {
      if (call.url.includes('/me/accessibility')) {
        if (call.method === 'PUT') return json(call.body);
        return json(DEFAULTS);
      }
      return json({}, 200);
    });

    const { container } = render(
      withQuery(
        <AccessibilityScreen organizationSlug="acme" organizationName="Acme" client={client} />,
      ),
    );

    // The form is seeded from the read: Medium is the checked font size to begin with.
    const medium = await screen.findByLabelText('Medium');
    expect((medium as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByLabelText('Large'));
    fireEvent.click(screen.getByLabelText('Reduce motion'));
    fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }));

    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT' && c.url.includes('/me/accessibility'));
      expect(put?.body).toEqual({ fontScale: 'lg', reduceMotion: true, highContrast: false });
    });

    expect(await screen.findByText('Saved')).toBeTruthy();
    await expectNoAxeViolations(container);
  });
});
