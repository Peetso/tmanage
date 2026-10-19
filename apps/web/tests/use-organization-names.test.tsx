import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { OrganizationSummary } from '../src/lib/api/organizations';
import { FIXTURE_ORGANIZATION_NAME } from '../src/lib/fixtures';
import { useOrganizationName } from '../src/lib/use-organization-names';

/**
 * ACC-14: the shell header must never fall back to the design's sample company. The real name
 * comes from the session's organization list; when the current organization is absent from a
 * loaded list (a removed member's old session) the resolved name is empty, not "Northstar Studio".
 */
function Probe({ slug }: { slug: string }) {
  const name = useOrganizationName(slug, FIXTURE_ORGANIZATION_NAME);
  return <span data-testid="name">{name}</span>;
}

function mountWith(organizations: readonly OrganizationSummary[], slug: string) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Prime the shared list so the hook reads the cache without a network call.
  query.setQueryData(['shell', 'organizations'], organizations);
  return render(
    <QueryClientProvider client={query}>
      <Probe slug={slug} />
    </QueryClientProvider>,
  );
}

const ROW: OrganizationSummary = {
  id: 'org-1',
  slug: 'northstar',
  name: 'Real Studio Name',
  audience: 'internal',
  role: 'org_admin',
  clientOrganizationName: null,
};

describe('useOrganizationName (ACC-14 fallback dropped)', () => {
  it('shows the organization its own name from the session list', () => {
    mountWith([ROW], 'northstar');
    expect(screen.getByTestId('name').textContent).toBe('Real Studio Name');
  });

  it('shows nothing, never the sample company, when the organization is gone from the list', () => {
    mountWith([], 'northstar');
    expect(screen.getByTestId('name').textContent).toBe('');
  });
});
