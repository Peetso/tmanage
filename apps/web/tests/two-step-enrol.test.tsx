import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { TwoStepSignInScreen, groupKey } from '../src/components/screens/TwoStepSignInScreen';
import { qrModules } from '../src/lib/qr-code';

interface Call {
  method: string;
  url: string;
  body: string | null;
  headers: Headers;
}

const ENROLMENT = {
  factorId: 'f1',
  secret: 'K7QX2M4P9LRA5TCE',
  uri: 'otpauth://totp/TManage:sara%40northstar.test?secret=K7QX2M4P9LRA5TCE&issuer=TManage',
};

function mount(routes: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : null,
        headers: new Headers(init?.headers),
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
  render(
    <QueryClientProvider client={query}>
      <TwoStepSignInScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        client={client}
      />
    </QueryClientProvider>,
  );
  return calls;
}

function failure(status: number, code: string, message: string) {
  return { status, body: { error: { code, message, correlationId: 'c' } } };
}

const NO_FACTORS = { status: 200, body: { factors: [], recoveryCodesRemaining: 0 } };

describe('TwoStepSignInScreen', () => {
  it('enrols: QR and grouped key, 6-digit confirm, then the recovery codes once', async () => {
    const calls = mount((call) => {
      if (call.url.endsWith('/v1/auth/factors/totp')) return { status: 201, body: ENROLMENT };
      if (call.url.endsWith('/confirm')) {
        return { status: 200, body: { recoveryCodes: ['aaaa-1111', 'bbbb-2222'] } };
      }
      return NO_FACTORS;
    });

    expect(await screen.findByTestId('tm-2s-qr')).toBeTruthy();
    expect(screen.getByDisplayValue('K7QX 2M4P 9LRA 5TCE').getAttribute('dir')).toBe('ltr');
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '482 913' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and turn on' }));

    const codes = await screen.findByTestId('tm-2s-codes');
    expect(codes.textContent).toContain('aaaa-1111');
    expect(codes.getAttribute('dir')).toBe('ltr');
    const confirm = calls.find((call) => call.url.endsWith('/confirm'));
    expect(JSON.parse(confirm?.body ?? '{}')).toEqual({ factorId: 'f1', code: '482913' });
  });

  it('shows the API error for a wrong code', async () => {
    mount((call) => {
      if (call.url.endsWith('/v1/auth/factors/totp')) return { status: 201, body: ENROLMENT };
      if (call.url.endsWith('/confirm')) {
        return failure(400, 'validation_failed', 'That code is not right.');
      }
      return NO_FACTORS;
    });
    fireEvent.change(await screen.findByLabelText('6-digit code'), {
      target: { value: '000000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and turn on' }));
    expect(await screen.findByText('That code is not right.')).toBeTruthy();
    expect(screen.queryByTestId('tm-2s-codes')).toBeNull();
  });

  it('answers reauthentication_required with the step-up form and retries with its proof', async () => {
    let proven = false;
    const calls = mount((call) => {
      if (call.url.endsWith('/v1/auth/reauth')) {
        proven = true;
        return { status: 200, body: { reauthToken: 'proof-1', expiresAt: '2026-10-22T12:05:00Z' } };
      }
      if (call.url.endsWith('/v1/auth/factors/totp')) {
        return proven
          ? { status: 201, body: ENROLMENT }
          : failure(403, 'reauthentication_required', 'Confirm it is you.');
      }
      return NO_FACTORS;
    });
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByTestId('tm-2s-qr')).toBeTruthy();
    const retried = calls.filter((call) => call.url.endsWith('/v1/auth/factors/totp')).at(-1);
    expect(retried?.headers.get('x-reauth-token')).toBe('proof-1');
  });
});

describe('QR and key helpers', () => {
  it('draws a version-sized grid with the three finder patterns', () => {
    const modules = qrModules(ENROLMENT.uri);
    const size = modules.length;
    expect((size - 17) % 4).toBe(0);
    for (const [x, y] of [
      [0, 0],
      [size - 7, 0],
      [0, size - 7],
    ] as const) {
      expect(modules[y]![x]).toBe(true);
      expect(modules[y + 1]![x + 1]).toBe(false);
      expect(modules[y + 3]![x + 3]).toBe(true);
    }
    expect(groupKey('K7QX2M4P9LRA5TCE')).toBe('K7QX 2M4P 9LRA 5TCE');
  });
});
