import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SignInScreen } from '../src/components/screens/SignInScreen';
import { ApiClient } from '../src/lib/api/client';
import { AuthBoundary } from '../src/lib/auth-boundary';

/** 51-05 "Continue with Microsoft": hidden unless configured, then starts its own flow. */

function clientOver(microsoft: 'on' | 'off' | 'down', urls: string[]): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const body = url.endsWith('/v1/auth/microsoft/start')
        ? { url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1' }
        : url.endsWith('/v1/auth/microsoft') && microsoft === 'on'
          ? { available: true, signUp: true }
          : { error: { code: 'not_found', message: 'Not found' } };
      const status = microsoft === 'down' ? 503 : 'error' in body ? 404 : 200;
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
}

describe('Continue with Microsoft', () => {
  it('is hidden when not configured and sends the browser to Microsoft when it is', async () => {
    const off: string[] = [];
    const { unmount } = render(
      <SignInScreen client={clientOver('off', off)} boundary={new AuthBoundary()} />,
    );
    await waitFor(() => expect(off.some((u) => u.endsWith('/v1/auth/microsoft'))).toBe(true));
    expect(screen.queryByRole('button', { name: /Continue with Microsoft/ })).toBeNull();
    unmount();

    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, assign, search: '' },
    });
    try {
      const urls: string[] = [];
      render(<SignInScreen client={clientOver('on', urls)} boundary={new AuthBoundary()} />);
      await userEvent
        .setup()
        .click(await screen.findByRole('button', { name: /Continue with Microsoft/ }));
      await waitFor(() =>
        expect(assign).toHaveBeenCalledWith(
          'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1',
        ),
      );
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('HT-3: keeps the button when the API cannot answer (503), and says "try again" on click', async () => {
    const urls: string[] = [];
    render(<SignInScreen client={clientOver('down', urls)} boundary={new AuthBoundary()} />);
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: /Continue with Microsoft/ }));
    expect(
      await screen.findByText(
        'Microsoft sign-in is temporarily unavailable. Try again in a moment.',
      ),
    ).toBeTruthy();
  });
});
