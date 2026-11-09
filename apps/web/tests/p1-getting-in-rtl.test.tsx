import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { InvitationScreen } from '../src/components/screens/InvitationScreen';
import { ApiClient } from '../src/lib/api/client';
import { activeLocale } from '../src/lib/i18n/locale-store';

/**
 * Slice P1, the Arabic frame of t1-a (369:1381): Arabic copy, the Latin organization name kept
 * inside a line that starts with U+200F, and the locked work email left to right.
 */

const RLM = '‏';

function client(): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            organizationName: 'Northstar Studio',
            inviterName: 'Omar Adel',
            inviterEmail: 'omar@northstar.studio',
            role: 'member',
            audience: 'internal',
            clientOrganizationName: null,
            invitedAt: '2026-08-13T09:00:00.000Z',
            expiresAt: '2026-08-20T09:00:00.000Z',
            inviteeEmail: 'salma@atlas-hospitality.com',
            hasAccount: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

afterEach(() => activeLocale.set('en-US'));

describe('P1 getting in, Arabic', () => {
  it('renders the invitation in Arabic with RTL-safe Latin names', async () => {
    activeLocale.set('ar-EG');
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queries}>
        <div dir="rtl">
          <InvitationScreen token="t" client={client()} />
        </div>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: 'أنشئ حسابك' }),
    ).toBeInTheDocument();
    const invited = screen.getByText(/Northstar Studio/);
    expect(invited.textContent?.startsWith(RLM)).toBe(true);
    expect(screen.getByLabelText(/^بريد العمل/)).toHaveAttribute('dir', 'ltr');
  });
});
