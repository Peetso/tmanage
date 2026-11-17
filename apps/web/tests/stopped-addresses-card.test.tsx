import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/lib/api/client';
import type { MailBounceStatus } from '../src/lib/api/mail-bounces';
import { StoppedAddressesCard } from '../src/components/admin/StoppedAddressesCard';

// 56-26 B2 (FIGMA9 678:37661): one test per state, and hidden without org.security.manage.
const CLEAR: MailBounceStatus = {
  status: 'clear',
  lastKind: null,
  lastStatus: null,
  lastBouncedAt: null,
  suppressedAt: null,
};
const STOPPED: MailBounceStatus = {
  status: 'suppressed',
  lastKind: 'hard',
  lastStatus: '5.1.1',
  lastBouncedAt: '2026-11-12T09:00:00.000Z',
  suppressedAt: '2026-11-12T09:00:00.000Z',
};

function mount(role: string, answer: (path: string) => unknown) {
  const request = vi.fn(async (input: { path: string; body?: unknown }) => {
    if (input.path === '/v1/organizations') {
      return { data: { organizations: [{ slug: 'acme', role }] } };
    }
    const data = answer(input.path);
    if (data instanceof Error) throw data;
    return { data };
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StoppedAddressesCard api={{ request } as unknown as ApiClient} organizationSlug="acme" />
    </QueryClientProvider>,
  );
  return request;
}

async function check(address: string) {
  fireEvent.change(await screen.findByLabelText('Check an e-mail address'), {
    target: { value: address },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Check' }));
}

describe('56-26 Addresses we stopped sending to', () => {
  it('is hidden without org.security.manage', async () => {
    const request = mount('member', () => CLEAR);
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(screen.queryByText('Addresses we stopped sending to')).toBeNull();
  });

  it('says we send normally, with the address in the body only', async () => {
    const request = mount('owner', () => CLEAR);
    await check('sara@nilefoods.com');
    expect(await screen.findByText(/normally/u)).toBeTruthy();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/v1/organizations/acme/mail/bounces/status',
        body: { address: 'sara@nilefoods.com' },
      }),
    );
  });

  it('shows a stopped address with its reason, confirms, and starts again', async () => {
    const request = mount('owner', (path) => (path.endsWith('/clear') ? CLEAR : STOPPED));
    await check('youssef@atlas-hospitality.com');
    expect(await screen.findByText(/The mailbox does not exist\./u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send to it again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement?.textContent).toBe('Send to it again');
    fireEvent.click(screen.getByRole('button', { name: 'Send to it again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, send to it again' }));
    expect(await screen.findByText(/normally/u)).toBeTruthy();
    expect(request.mock.calls.some(([input]) => input.path.endsWith('/clear'))).toBe(true);
  });

  it('names a spam complaint as the reason (0370)', async () => {
    mount('owner', () => ({ ...STOPPED, lastKind: 'complaint', lastStatus: 'abuse' }));
    await check('youssef@atlas-hospitality.com');
    expect(await screen.findByText(/The person marked your mail as spam\./u)).toBeTruthy();
    expect(screen.queryByText(/keeps refusing/u)).toBeNull();
  });

  it('shows a calm error when the check fails', async () => {
    mount('owner', () => new Error('offline'));
    await check('a@b.co');
    expect(await screen.findByText('We could not check this address')).toBeTruthy();
  });
});
