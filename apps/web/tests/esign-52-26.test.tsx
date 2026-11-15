import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PortalSignScreen } from '../src/components/screens/esign/PortalSignScreen';
import { ApiClient } from '../src/lib/api/client';

/** 52-26: the portal sign screen's states and the Sign gate (consent + code + name or mark). */
const VIEW = {
  ...{ id: 'sr1', title: 'Brand services agreement', projectId: 'p1' },
  ...{ deliverableVersionId: 'dv1', fileVersionId: null, organizationName: 'Atlas Studio' },
  ...{ state: 'pending', signedAt: null, expiresAt: '2026-11-21T10:00:00.000Z' },
  ...{ emailHint: 'l•••@alnoor.test', codeLive: true, signerName: 'Layla Haddad' },
  ...{ consentText: 'I agree to sign this document electronically.', consentTextVersion: 'v1' },
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const expired = {
  error: { code: 'validation_failed', message: 'x', correlationId: 'c', details: [] as unknown[] },
};
expired.error.details.push({ field: 'code', message: 'code_expired' });

function screenWith(view: object) {
  const api = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input).endsWith('/sign') ? json(expired, 400) : json(view),
      )) as typeof fetch,
    readCsrfToken: () => 'csrf',
    newCorrelationId: () => 'corr',
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PortalSignScreen
        {...{ organizationSlug: 'acme', clientName: 'A', providerName: 'B' }}
        requestId="sr1"
        client={api}
      />
    </QueryClientProvider>,
  );
}

describe('52-26 portal sign', () => {
  it('a signed request says so and offers the document', async () => {
    screenWith({ ...VIEW, state: 'signed', signedAt: '2026-11-12T09:00:00.000Z' });
    expect(await screen.findByText(/Already signed/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign document' })).toBeNull();
  });

  it('Sign waits for consent, code and a mark; an expired code offers a new one', async () => {
    screenWith(VIEW);
    const sign = await screen.findByRole('button', { name: 'Sign document' });
    expect(sign).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByLabelText(VIEW.consentText));
    expect(sign).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText(/6-digit code/), { target: { value: '482 913' } });
    expect(sign).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('button', { name: 'Draw' }));
    expect(sign).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Type' }));
    fireEvent.click(sign);
    expect(await screen.findByText('Code expired')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send a new code' })).toBeTruthy();
  });
});
