import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { TwoStepSignInScreen } from '../src/components/screens/TwoStepSignInScreen';
import { ConfirmEmailScreen } from '../src/components/screens/ConfirmEmailScreen';
import { localeFromSearch } from '../src/lib/i18n/locale-boot';
import { activeLocale } from '../src/lib/i18n/locale-store';

/**
 * VERIFYMAIL (2026-11-16): a password account could not confirm its address, so e-mail codes
 * and Platform admin stayed closed to it. The notice sends a link; the link's page confirms on
 * a click, never on load.
 */
interface Call {
  method: string;
  url: string;
  body: string | null;
}

function client(routes: (call: Call) => { status: number; body?: unknown }, calls: Call[]) {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : null,
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
}

function factors(verified: boolean) {
  return {
    status: 200,
    body: {
      factors: [],
      recoveryCodesRemaining: 0,
      email: { address: 'o•••@example.test', verified },
    },
  };
}

function mountTwoStep(verified: boolean, send: { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const api = client(
    (call) => (call.url.endsWith('/v1/email-confirmations') ? send : factors(verified)),
    calls,
  );
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={query}>
      <TwoStepSignInScreen organizationSlug="northstar" organizationName="Northstar" client={api} />
    </QueryClientProvider>,
  );
  return calls;
}

describe('the "Confirm your e-mail" notice on Two-step sign-in', () => {
  it('sends a link to the own address and says so', async () => {
    const calls = mountTwoStep(false, { status: 202, body: { status: 'sent' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Send confirmation e-mail' }));
    expect(
      await screen.findByText('Sent. Open the e-mail and click the link within 30 minutes.'),
    ).toBeTruthy();
    const sent = calls.filter((call) => call.url.endsWith('/v1/email-confirmations'));
    expect(sent.map((call) => [call.method, call.body])).toEqual([['POST', null]]);
  });

  it('says "try again later" when the send is refused', async () => {
    mountTwoStep(false, {
      status: 429,
      body: { error: { code: 'rate_limited', message: 'x', correlationId: 'c' } },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Send confirmation e-mail' }));
    expect(
      await screen.findByText('We could not send it right now. Try again later.'),
    ).toBeTruthy();
  });

  it('is not shown once the address is confirmed', async () => {
    mountTwoStep(true, { status: 202, body: { status: 'sent' } });
    await screen.findByRole('button', { name: 'Turn on · Authenticator app' });
    expect(screen.queryByRole('button', { name: 'Send confirmation e-mail' })).toBeNull();
  });
});

describe('the confirmation link page', () => {
  const TOKEN = 'A'.repeat(43);

  it('spends the link only on a click, in the body, and never renders it', async () => {
    const calls: Call[] = [];
    render(<ConfirmEmailScreen token={TOKEN} client={client(() => ({ status: 204 }), calls)} />);
    expect(calls).toHaveLength(0);
    expect(document.body.textContent?.includes(TOKEN)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm my e-mail' }));
    expect(await screen.findByText('Your e-mail is confirmed.')).toBeTruthy();
    expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
      [
        'POST',
        'https://api.example.test/v1/email-confirmations/completions',
        JSON.stringify({ token: TOKEN }),
      ],
    ]);
  });

  afterEach(() => {
    act(() => activeLocale.set('en-US'));
  });

  it('opens in the language its mail link names (?lang=ar, ?lang=ur)', () => {
    for (const [search, button] of [
      ['?lang=ar', 'تأكيد بريدي'],
      ['?lang=ur', 'میری ای میل کی تصدیق کریں'],
    ] as const) {
      const locale = localeFromSearch(search);
      if (locale === undefined) throw new Error(`no locale for ${search}`);
      act(() => activeLocale.set(locale));
      const view = render(
        <ConfirmEmailScreen token={TOKEN} client={client(() => ({ status: 204 }), [])} />,
      );
      expect(screen.getByRole('button', { name: button })).toBeTruthy();
      view.unmount();
    }
  });

  it('a used or expired link says how to get a new one', async () => {
    const calls: Call[] = [];
    const notFound = {
      status: 404,
      body: { error: { code: 'not_found', message: 'x', correlationId: 'c' } },
    };
    render(<ConfirmEmailScreen token={TOKEN} client={client(() => notFound, calls)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm my e-mail' }));
    expect(
      await screen.findByText(
        'This link has expired or was already used. Sign in and send a new one from Two-step sign-in.',
      ),
    ).toBeTruthy();
  });
});
