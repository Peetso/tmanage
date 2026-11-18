import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApproveSheet } from '../src/components/screens/MyDayPhoneSheets';
import { ApiClient } from '../src/lib/api/client';

/** PHONE (55-20): approve or send back a waiting review from My Day, in a bottom sheet. */
function mount(intent: 'approve' | 'request_changes') {
  const calls: { path: string; body: unknown }[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        path: new URL(String(input)).pathname,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Promise.resolve(
        new Response(JSON.stringify({ id: 'ap1', state: 'approved' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf',
    newCorrelationId: () => 'c',
  });
  const onDecided = vi.fn();
  const onClose = vi.fn();
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={query}>
      <ApproveSheet
        api={client}
        organizationSlug="acme"
        approvalId="ap1"
        version={3}
        subject="Homepage hero · v3"
        intent={intent}
        onClose={onClose}
        onDecided={onDecided}
      />
    </QueryClientProvider>,
  );
  return { calls, onDecided, onClose };
}

afterEach(cleanup);

describe('My Day phone · Approve sheet', () => {
  it('approves in one tap from the sheet, with the version read, and Send back waits for a note', async () => {
    const { calls, onDecided } = mount('approve');
    const dialog = screen.getByRole('dialog', { name: /approve “homepage hero · v3”\?/i });
    expect(dialog).toBeTruthy();
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(document.activeElement).toBe(approve);
    expect((screen.getByRole('button', { name: 'Send back' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.click(approve);
    await waitFor(() => expect(onDecided).toHaveBeenCalledWith('approve'));
    expect(calls).toEqual([
      {
        path: '/v1/organizations/acme/approvals/ap1/decision',
        body: { decision: 'approve', version: 3 },
      },
    ]);
  });

  it('sends back with the note; Escape closes the sheet', async () => {
    const { calls, onDecided, onClose } = mount('request_changes');
    const field = screen.getByLabelText('What should change?');
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: 'Use the darker logo' } });
    const sendBack = screen.getByRole('button', { name: 'Send back' }) as HTMLButtonElement;
    expect(sendBack.disabled).toBe(false);
    fireEvent.click(sendBack);
    await waitFor(() => expect(onDecided).toHaveBeenCalledWith('request_changes'));
    expect(calls[0]?.body).toEqual({
      decision: 'request_changes',
      version: 3,
      feedback: 'Use the darker logo',
    });

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
