import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { projectIdFromPath } from '../src/lib/api/support';
import { SupportLauncher } from '../src/components/support/SupportLauncher';

const THREAD = '0199aa00-0000-7000-8000-0000000000e1';

interface Call {
  method: string;
  url: string;
  body: string | null;
}

function detail(subject: string) {
  return {
    thread: {
      id: THREAD,
      subject,
      status: 'open',
      contextPath: '/northstar/work',
      appVersion: '0.1.0',
      startedByName: 'Lina',
      mine: true,
      messageCount: 1,
      lastAuthorKind: 'member',
      lastMessageAt: '2026-11-08T10:00:00.000Z',
      createdAt: '2026-11-08T10:00:00.000Z',
      closedAt: null,
    },
    organizationSlug: 'northstar',
    messages: [
      {
        id: 'm1',
        authorKind: 'member',
        authorName: 'Lina',
        mine: true,
        body: 'Logo is wrong',
        attachmentName: null,
        createdAt: '2026-11-08T10:00:00.000Z',
      },
    ],
  };
}

function mount(pathname: string) {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : null,
      };
      calls.push(call);
      const body =
        call.method === 'POST'
          ? detail('Invoice logo')
          : call.url.endsWith('/support/threads')
            ? { threads: [] }
            : detail('Invoice logo');
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: call.method === 'POST' ? 201 : 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={query}>
      <SupportLauncher organizationSlug="northstar" client={client} pathname={pathname} />
    </QueryClientProvider>,
  );
  return calls;
}

describe('55-17 support panel', () => {
  it('shows the context before sending and sends it with the message', async () => {
    const calls = mount('/northstar/work');
    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Contact support' }));
    fireEvent.click(await screen.findByRole('button', { name: 'New conversation' }));

    // The context the person sees is the context that is sent.
    expect(screen.getByText('/northstar/work')).toBeTruthy();
    expect(screen.getAllByText('northstar').length).toBeGreaterThan(0);
    // Not on a project page: no screenshot picker (an upload needs a project).
    expect(screen.queryByLabelText(/Attach a screenshot/u)).toBeNull();

    fireEvent.change(screen.getByLabelText(/Subject/u), { target: { value: 'Invoice logo' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Logo is wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to support' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toContain('/v1/organizations/northstar/support/threads');
    expect(JSON.parse(post?.body ?? '{}')).toMatchObject({
      subject: 'Invoice logo',
      message: 'Logo is wrong',
      contextPath: '/northstar/work',
      attachmentFileId: null,
    });
    expect(await screen.findByRole('heading', { name: 'Invoice logo' })).toBeTruthy();
  });

  it('refuses to send without a subject and a message', async () => {
    const calls = mount('/northstar/work');
    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Contact support' }));
    fireEvent.click(await screen.findByRole('button', { name: 'New conversation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send to support' }));
    expect(await screen.findByText('Write a subject and a message.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('offers a screenshot only on a project page', () => {
    expect(projectIdFromPath(`/northstar/projects/${THREAD}/board`)).toBe(THREAD);
    expect(projectIdFromPath('/northstar/work')).toBeNull();
  });
});
