import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { AiApproveScreen } from '../src/components/screens/AiApproveScreen';
import { ApiClient } from '../src/lib/api/client';
import type { AiApprovalView } from '../src/lib/api/ai-approvals';

/**
 * S10 approve page against Figma 365:1214 (design fix APPROVE): the bold line names the item, the
 * delete confirm is the filled danger capsule, and the requester avatar carries the design-system
 * name tint (ADM-19), never the client violet. The Arabic lookup of op titles and field labels is
 * proved in `ai-approval-presentation.test.ts`.
 */

const NOW = Date.parse('2026-10-22T12:00:00.000Z');

const VIEW: AiApprovalView = {
  id: 'pa-1',
  status: 'pending',
  clientName: 'Claude',
  memberName: 'Maya Hassan',
  memberEmail: 'maya@northstar.studio',
  summary: {
    opId: 'work_items.delete',
    title: 'Delete work item',
    method: 'DELETE',
    destructive: true,
    notifies: false,
    subject: 'Homepage direction review',
    fields: [{ name: 'workItemId', value: '#2451' }],
  },
  expiresAt: new Date(NOW + 581_000).toISOString(),
  decidedAt: null,
};

function clientReturning(view: AiApprovalView): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify(view), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('S10 approve screen matches Figma 365:1214', () => {
  it('names the item, fills the delete confirm and tints the requester avatar', async () => {
    const { container } = render(
      withQuery(
        <AiApproveScreen
          orgSlug="northstar"
          approvalId="pa-1"
          client={clientReturning(VIEW)}
          now={() => NOW}
        />,
      ),
    );

    const subject = await screen.findByText('Delete “Homepage direction review”');
    expect(subject).toHaveClass('tm-approve__subject');

    const confirm = screen.getByRole('button', {
      name: /aiApprove\.approveDelete|Approve and delete/,
    });
    expect(confirm).toHaveClass('tm-button--destructive', 'tm-approve__confirm--danger');

    const avatar = container.querySelector('.tm-approve__requester .tm-avatar');
    expect(avatar?.className).toMatch(/tm-avatar--tint-[0-5]/);
    expect(avatar).not.toHaveClass('tm-avatar--client');
  });

  it('leaves the bold line out when the server could not name the item', async () => {
    const view = { ...VIEW, summary: { ...VIEW.summary, subject: null } };
    const { container } = render(
      withQuery(
        <AiApproveScreen
          orgSlug="northstar"
          approvalId="pa-1"
          client={clientReturning(view)}
          now={() => NOW}
        />,
      ),
    );
    await screen.findByText('Delete work item');
    expect(container.querySelector('.tm-approve__subject')).toBeNull();
  });
});
