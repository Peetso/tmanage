import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import type { PlatformMeView } from '../src/lib/api/platform-admin';
import { StepUpForm } from '../src/components/platform/shared/platform-kit';

/**
 * STEPUPFIX (live 2026-11-19): the owner's two-step is by e-mail codes. The Platform admin step-up
 * showed a required "Two-step code" field for anyone with two-step on, the server never mails a
 * code for a step-up, and the owner was locked out. The field now follows the server's
 * `stepUpNeedsAuthenticatorCode`.
 */

afterEach(cleanup);

const CODE_LABEL = 'Authenticator app code';

function me(stepUpNeedsAuthenticatorCode: boolean): PlatformMeView {
  return {
    email: 'owner@example.test',
    displayName: 'Owner',
    mfaEnabled: true,
    stepUpNeedsAuthenticatorCode,
    stepUpExpiresAt: null,
    stepUpMinutes: 1440,
    source: 'env',
    preset: 'super_admin',
    permissions: [],
    supportSessions: [],
  };
}

function mount(view: PlatformMeView) {
  const bodies: unknown[] = [];
  const api = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
      return Promise.resolve(
        new Response(JSON.stringify({ expiresAt: '2026-11-20T10:00:00.000Z', mfaVerified: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StepUpForm api={api} me={view} />
    </QueryClientProvider>,
  );
  return bodies;
}

describe('Platform admin step-up form (STEPUPFIX)', () => {
  it('two-step by e-mail codes: no code field, the password alone is sent, the note says why', async () => {
    const bodies = mount(me(false));
    expect(screen.queryByLabelText(CODE_LABEL, { exact: false })).toBeNull();
    expect(screen.getByText(/already passed the e-mail code step/u)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Password', { exact: false }), {
      target: { value: 'pw' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(bodies).toEqual([{ password: 'pw' }]));
  });

  it('an authenticator app: the 6-digit code field is shown and sent', async () => {
    const bodies = mount(me(true));
    expect(screen.queryByText(/already passed the e-mail code step/u)).toBeNull();
    fireEvent.change(screen.getByLabelText('Password', { exact: false }), {
      target: { value: 'pw' },
    });
    fireEvent.change(screen.getByLabelText(CODE_LABEL, { exact: false }), {
      target: { value: '123 456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(bodies).toEqual([{ password: 'pw', code: '123456' }]));
  });
});
