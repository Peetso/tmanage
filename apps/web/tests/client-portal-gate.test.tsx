import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrganizationSummary } from '../src/lib/api/organizations';
import { AppShell } from '../src/components/shell/AppShell';
import { ClientPortalGate } from '../src/components/shell/ClientPortalGate';

/**
 * T5 F7: a client member who opens a staff address goes to the portal home before any staff UI
 * draws. Rendered through `AppShell`, so the test fails if the shell stops mounting the gate.
 */
const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/atlas/projects/p1',
  useSearchParams: () => new URLSearchParams(),
}));

const membership = (audience: OrganizationSummary['audience']): OrganizationSummary => ({
  id: 'o1',
  slug: 'atlas',
  name: 'Atlas Studio',
  audience,
  role: audience === 'client' ? 'client_approver' : 'member',
  clientOrganizationName: audience === 'client' ? 'Cedar Foods' : null,
});

function withSession(audience: OrganizationSummary['audience'], children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['shell', 'organizations'], [membership(audience)]);
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

describe('ClientPortalGate (T5 F7)', () => {
  beforeEach(() => replace.mockClear());

  it('sends a client member on a staff screen to the portal home, drawing no staff shell', () => {
    withSession(
      'client',
      <AppShell organizationSlug="atlas" organizationName="Atlas Studio" title="Website Relaunch">
        <p>Project tabs</p>
      </AppShell>,
    );
    expect(replace).toHaveBeenCalledWith('/atlas/portal');
    expect(screen.queryByText('Project tabs')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('lets a staff member through', () => {
    withSession(
      'internal',
      <ClientPortalGate organizationSlug="atlas">
        <p>Project tabs</p>
      </ClientPortalGate>,
    );
    expect(screen.getByText('Project tabs')).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });
});
