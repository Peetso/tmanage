import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MembershipGoneGate } from '../src/components/shell/MembershipGoneGate';
import { rememberOrganizations } from '../src/components/shell/known-memberships';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

function renderGate(slug: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['shell', 'organizations'], [{ id: 'o1', slug: 'northstar' }]);
  return render(
    <QueryClientProvider client={client}>
      <MembershipGoneGate organizationSlug={slug}>
        <p>Canvas</p>
      </MembershipGoneGate>
    </QueryClientProvider>,
  );
}

describe('MembershipGoneGate (B16)', () => {
  beforeEach(() => window.localStorage.clear());

  it('shows not-found, not "no longer have access", for a slug this browser never saw', () => {
    renderGate('admin');
    expect(screen.queryByText('You no longer have access')).toBeNull();
    expect(screen.queryByText('Canvas')).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to home' }).getAttribute('href')).toBe(
      '/organizations',
    );
  });

  it('shows the removed-access page for an organization seen in an earlier list', () => {
    rememberOrganizations(['atlas']);
    renderGate('atlas');
    expect(screen.getByText('You no longer have access')).toBeTruthy();
  });
});
