import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { roleMayUse } from '../src/lib/role-capability';
import { controlCenterSectionsFor } from '../src/components/admin/ControlCenterShell';
import { OrgSettingsScreen } from '../src/components/screens/OrgSettingsScreen';
import { PeopleDirectoryScreen } from '../src/components/screens/PeopleDirectoryScreen';

/**
 * H1 — a custom-role member is no longer treated as "no role" by the browser. The organization
 * list carries the role's name and loaded set; the People list carries each person's role name.
 */

const ROLE_ID = '0192a8f0-0000-7000-8000-00000000c0de';

function sections(role: string, capabilities?: readonly string[]): string[] {
  return controlCenterSectionsFor(role, capabilities).groups.flatMap((group) =>
    group.items.map((item) => item.id),
  );
}

function recordingClient(answer: (path: string) => { status: number; body: unknown }) {
  const calls: string[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      calls.push(url.pathname);
      const { status, body } = answer(url.pathname);
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  return { client, calls };
}

function withOrganization(
  children: ReactNode,
  summary: { role: string; roleName?: string; capabilities?: readonly string[] },
) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queries.setQueryData(
    ['shell', 'organizations'],
    [{ id: 'o1', slug: 'northstar', name: 'Northstar Studio', audience: 'internal', ...summary }],
  );
  return <QueryClientProvider client={queries}>{children}</QueryClientProvider>;
}

describe('roleMayUse', () => {
  it('answers a built-in role from the ceiling and a custom role from its loaded set', () => {
    expect(roleMayUse('owner', undefined, 'org.manage')).toBe(true);
    expect(roleMayUse('member', ['org.manage'], 'org.manage')).toBe(false);
    expect(roleMayUse(ROLE_ID, ['org.manage'], 'org.manage')).toBe(true);
    expect(roleMayUse(ROLE_ID, ['work.read'], 'org.manage')).toBe(false);
    expect(roleMayUse(ROLE_ID, undefined, 'work.read')).toBe(false);
    expect(roleMayUse(undefined, ['org.manage'], 'org.manage')).toBe(false);
  });
});

describe('Control Center menu for a custom role', () => {
  it('opens the pages the custom set holds, and no more', () => {
    expect(sections(ROLE_ID, ['org.manage'])).toContain('roles');
    expect(sections(ROLE_ID, ['org.manage'])).toContain('organization');
    expect(sections(ROLE_ID, [])).not.toContain('roles');
    expect(sections(ROLE_ID)).toEqual(sections(ROLE_ID, []));
  });
});

describe('Organization settings for a custom role', () => {
  it('reads the settings for a custom role holding org.manage', async () => {
    const { client, calls } = recordingClient(() => ({ status: 200, body: { settings: [] } }));
    render(
      withOrganization(
        <OrgSettingsScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
        />,
        {
          role: ROLE_ID,
          roleName: 'Studio lead',
          capabilities: ['org.manage'],
        },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.some((path) => path.includes('/settings'))).toBe(true);
  });

  it('reads nothing for a custom role without org.manage', async () => {
    const { client, calls } = recordingClient(() => ({ status: 200, body: {} }));
    const { container } = render(
      withOrganization(
        <OrgSettingsScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
        />,
        {
          role: ROLE_ID,
          roleName: 'Night editor',
          capabilities: ['work.read'],
        },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container).toBeEmptyDOMElement();
    expect(calls).toEqual([]);
  });
});

describe('People list names a custom role for a member viewer', () => {
  it('shows the role name the API sent, though Control > Roles is refused to this viewer', async () => {
    const { client } = recordingClient((path) => {
      if (path.endsWith('/people')) {
        return {
          status: 200,
          body: {
            people: [
              {
                userId: 'u-sara',
                displayName: 'Sara Ali',
                role: ROLE_ID,
                roleName: 'Night editor',
                status: 'active',
                projectCount: 2,
                membershipId: 'm-sara',
                version: 1,
                teams: [],
                openCommitments: 0,
                overdueCommitments: 0,
                declared: null,
              },
            ],
            nextAfter: null,
          },
        };
      }
      if (path.endsWith('/admin/roles')) return { status: 403, body: { code: 'forbidden' } };
      return { status: 200, body: { invitations: [], projects: [], connections: [] } };
    });
    render(
      withOrganization(
        <PeopleDirectoryScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
        />,
        { role: 'member' },
      ),
    );
    expect(await screen.findByText('Night editor')).toBeTruthy();
    expect(screen.queryByText('Custom role')).toBeNull();
  });
});
