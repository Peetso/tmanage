import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DeliverablesScreen } from '../src/components/screens/DeliverablesScreen';
import { DeliverableDetailScreen } from '../src/components/screens/DeliverableDetailScreen';
import { ApiClient } from '../src/lib/api/client';

/**
 * P7 — the team deliverables screens over a fake API. The `Deliverables.*` strings arrive with the
 * P7 catalog fragment, so the translator is the identity here and the test reads keys.
 */
vi.mock('../src/lib/i18n/use-t', () => ({ useT: () => (key: string) => key }));
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useRouter: () => ({ push }),
}));

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function fakeApi(route: (call: Call) => unknown) {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url: String(input),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return Promise.resolve(
        new Response(JSON.stringify(route(call) ?? {}), {
          status: call.method === 'POST' ? 201 : 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, calls };
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function deliverable(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    projectId: 'p1',
    title: 'Homepage concept',
    description: null,
    state: 'draft',
    latestVersionNo: 2,
    sharedWithClient: false,
    createdByUserId: 'u1',
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:00.000Z',
    ...overrides,
  };
}

function version(approval: unknown = null) {
  return {
    id: 'v2',
    versionNo: 2,
    fileAssetId: 'f1',
    fileVersionId: 'fv1',
    note: 'Bigger booking button',
    createdByUserId: 'u1',
    createdAt: '2026-10-21T10:00:00.000Z',
    sharedWithClientAt: null,
    approval,
  };
}

describe('DeliverablesScreen', () => {
  it('lists each deliverable with its state and latest version', async () => {
    const { client } = fakeApi(() => ({
      deliverables: [
        deliverable(),
        deliverable({ id: 'd2', title: 'Brand book', state: 'approved', latestVersionNo: 3 }),
      ],
    }));
    render(
      withQuery(
        <DeliverablesScreen
          organizationSlug="north"
          organizationName="North"
          projectId="p1"
          client={client}
        />,
      ),
    );
    expect(await screen.findByText('Homepage concept')).toBeTruthy();
    expect(screen.getByText('Deliverables.stateDraft')).toBeTruthy();
    expect(screen.getByText('Deliverables.stateApproved')).toBeTruthy();
    expect(screen.getByText('v3')).toBeTruthy();
  });

  it('creates a deliverable for the project', async () => {
    const { client, calls } = fakeApi((call) =>
      call.method === 'POST' ? deliverable() : { deliverables: [] },
    );
    render(
      withQuery(
        <DeliverablesScreen
          organizationSlug="north"
          organizationName="North"
          projectId="p1"
          client={client}
        />,
      ),
    );
    await screen.findByText('Deliverables.empty');
    fireEvent.change(screen.getByLabelText(/Deliverables.titleLabel/), {
      target: { value: 'Homepage concept' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Deliverables.create' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      projectId: 'p1',
      title: 'Homepage concept',
      description: null,
    });
  });
});

describe('DeliverableDetailScreen', () => {
  it('FIX6 item 8 / UX-1: shares the newest version, and deletes a deliverable after confirming', async () => {
    const { client, calls } = fakeApi((call) =>
      call.method === 'POST'
        ? { deliverableVersionId: 'v2', sharedWithClientAt: '2026-11-15T10:00:00.000Z' }
        : { ...deliverable(), versions: [version()] },
    );
    render(
      withQuery(
        <DeliverableDetailScreen
          organizationSlug="north"
          organizationName="North"
          projectId="p1"
          deliverableId="d1"
          client={client}
        />,
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Deliverables.shareWithClient' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.url).toContain(
        '/deliverables/d1/versions/v2/share',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete deliverable' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.url.endsWith('/deliverables/d1/delete')),
      ).toBe(true),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith('/north/projects/p1/deliverables'));
  });

  it('uploads a new version with a note', async () => {
    const { client, calls } = fakeApi((call) =>
      call.method === 'POST' ? version() : { ...deliverable(), versions: [version()] },
    );
    render(
      withQuery(
        <DeliverableDetailScreen
          organizationSlug="north"
          organizationName="North"
          projectId="p1"
          deliverableId="d1"
          client={client}
        />,
      ),
    );
    await screen.findByText('Bigger booking button');
    fireEvent.change(screen.getByLabelText('Deliverables.noteLabel'), {
      target: { value: 'New hero copy' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Deliverables.uploadNewVersion' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')).toMatchObject({
        url: expect.stringContaining('/deliverables/d1/versions'),
        body: { fileAssetId: null, note: 'New hero copy' },
      }),
    );
  });

  it('sends the version for approval and shows it in review', async () => {
    let sent = false;
    const { client, calls } = fakeApi((call) => {
      if (call.url.endsWith('/approvers')) {
        return {
          approvers: [
            {
              userId: 'c1',
              displayName: 'Youssef Kamal',
              clientOrganizationName: 'Atlas Hospitality',
            },
          ],
        };
      }
      if (call.method === 'POST') {
        sent = true;
        return {
          approvalId: 'a1',
          deliverableVersionId: 'v2',
          state: 'requested',
          reviewerIds: ['c1'],
        };
      }
      const approval = sent
        ? { id: 'a1', state: 'requested', reviewerIds: ['c1'], feedback: null, decidedAt: null }
        : null;
      return {
        ...deliverable({ state: sent ? 'in_review' : 'draft' }),
        versions: [version(approval)],
      };
    });
    render(
      withQuery(
        <DeliverableDetailScreen
          organizationSlug="north"
          organizationName="North"
          projectId="p1"
          deliverableId="d1"
          client={client}
        />,
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Deliverables.sendForApproval' }));
    await screen.findByText('Youssef Kamal · Atlas Hospitality');
    fireEvent.change(screen.getByLabelText('Deliverables.dueLabel'), {
      target: { value: '2026-11-02' },
    });
    fireEvent.change(screen.getByLabelText('Deliverables.checkLabel'), {
      target: { value: 'Booking is easy to find' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Deliverables.send' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')).toMatchObject({
        url: expect.stringContaining('/deliverables/d1/versions/v2/send'),
        body: {
          approverIds: ['c1'],
          dueDate: '2026-11-02',
          checkNote: 'Booking is easy to find',
          notify: true,
        },
      }),
    );
    expect(await screen.findByText('Deliverables.stateInReview')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Deliverables.portalLink' }).getAttribute('href')).toBe(
      '/north/portal/deliverables/v2',
    );
  });
});
