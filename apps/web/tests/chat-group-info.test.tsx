import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GroupInfoPanel } from '../src/components/chat/GroupInfoPanel';
import { ApiClient } from '../src/lib/api/client';
import type { GroupInfo } from '../src/lib/api/chat-groups';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const api = new ApiClient({
  baseUrl: 'https://api.example.test',
  csrfCookieName: 'tm_session_csrf',
  readCsrfToken: () => undefined,
  newCorrelationId: () => 'c1',
  fetch: (() =>
    Promise.resolve(
      new Response('{"members":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )) as typeof fetch,
});

const info: GroupInfo = {
  conversationId: 'g1',
  name: 'Atlas launch crew',
  description: null,
  photoFileAssetId: null,
  onlyAdminsCanSend: true,
  viewerRole: 'member',
  inviteToken: null,
  members: [
    {
      userId: 'u1',
      displayName: 'Omar Ali',
      role: 'admin',
      isClient: false,
      joinedAt: '2026-11-01T00:00:00Z',
    },
    {
      userId: 'u2',
      displayName: 'Lina Hassan',
      role: 'member',
      isClient: true,
      joinedAt: '2026-11-01T00:00:00Z',
    },
  ],
};

describe('GroupInfoPanel', () => {
  it('marks admins and clients, and hides admin controls from a member', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <GroupInfoPanel
          api={api}
          organizationSlug="northstar"
          conversationId="g1"
          afterLeaveHref="/northstar/chat"
          initial={info}
        />
      </QueryClientProvider>,
    );
    const rows = screen.getAllByRole('listitem');
    expect(within(rows[0] as HTMLElement).getByText('Admin')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('Client')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText('Make admin')).toBeNull();
  });
});
