import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useBetaBillingHeading } from '../src/components/billing/BetaBillingPanel';
import { FIXTURE_ORGANIZATION_NAME } from '../src/lib/fixtures';

/**
 * FIX3 item 3 (live check a6f66e47, S1): Billing said "Northstar Studio is on the TManage beta"
 * in the "QA test (delete me)" workspace — the page passes the design's sample name. The heading
 * now names the organization the session's own list has for the slug.
 */
describe('the beta billing heading', () => {
  it("names the current organization, not the design's sample company", () => {
    const queries = new QueryClient();
    queries.setQueryData(
      ['shell', 'organizations'],
      [
        {
          id: 'o1',
          slug: 'qa-test-delete-me',
          name: 'QA test (delete me)',
          audience: 'internal',
          role: 'owner',
          clientOrganizationName: null,
        },
      ],
    );
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queries}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => useBetaBillingHeading('qa-test-delete-me', FIXTURE_ORGANIZATION_NAME),
      { wrapper },
    );
    expect(result.current.description).toContain('QA test (delete me)');
    expect(result.current.description).not.toContain(FIXTURE_ORGANIZATION_NAME);
  });
});
