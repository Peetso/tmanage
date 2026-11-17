import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/lib/api/client';
import { PendingInvitationsSection } from '../src/components/people/PendingInvitations';
import type { PendingInvitation } from '../src/components/people/PendingInvitations';

// 56-26 B1 (FIGMA9 678:37662 admin, 678:37694 member): one test per state.
const ADDRESS = 'youssef@atlas-hospitality.com';

function invitation(deliveryStopped: boolean): PendingInvitation {
  return {
    id: 'inv-1',
    email: ADDRESS,
    role: 'member',
    invitedByUserId: 'u-1',
    invitedByName: 'Lina Haddad',
    invitedByEmail: 'lina@northstar.example',
    expiresAt: '2026-11-30T10:00:00Z',
    createdAt: '2026-11-10T10:00:00Z',
    isExpired: false,
    projects: [],
    deliveryStopped,
  };
}

function mount(role: string, deliveryStopped: boolean) {
  const request = vi.fn(async (input: { path: string }) =>
    input.path === '/v1/organizations'
      ? { data: { organizations: [{ slug: 'acme', role }] } }
      : { data: { status: 'clear' } },
  );
  const onResend = vi.fn();
  const onCheckAddress = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PendingInvitationsSection
        api={{ request } as unknown as ApiClient}
        organizationSlug="acme"
        invitations={[invitation(deliveryStopped)]}
        roleLabel={(value) => value}
        busyId={null}
        onChangeRole={() => undefined}
        onRevoke={() => undefined}
        onResend={onResend}
        onCheckAddress={onCheckAddress}
      />
    </QueryClientProvider>,
  );
  return { request, onResend, onCheckAddress };
}

describe('56-26 B1 invitation not delivered', () => {
  it('member: names the address in an isolate, announced, with only Check the address', async () => {
    const { request, onCheckAddress } = mount('member', true);
    expect(screen.getByText('Not delivered')).toBeTruthy();
    const notice = screen.getByRole('status');
    expect(notice.textContent).toContain("didn't arrive");
    expect(notice.querySelector('bdi')?.textContent).toBe(ADDRESS);
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Send to it again' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check the address' }));
    expect(onCheckAddress).toHaveBeenCalledTimes(1);
  });

  it('admin: Send to it again clears the address in the body, then resends', async () => {
    const { request, onResend } = mount('owner', true);
    fireEvent.click(await screen.findByRole('button', { name: 'Send to it again' }));
    await waitFor(() => expect(onResend).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/v1/organizations/acme/mail/bounces/clear',
        body: { address: ADDRESS },
      }),
    );
  });

  it('not stopped: no chip and no notice', () => {
    mount('owner', false);
    expect(screen.queryByText('Not delivered')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
