import { onlineManager } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryProvider } from '../src/components/providers/QueryProvider';
import { LogTimeSheet } from '../src/components/screens/MyDayPhoneSheets';
import { ApiClient } from '../src/lib/api/client';

/**
 * TESTUX P1 8: offline, Log time sat on a grey "Working" and nothing said it was kept. The app's
 * query client parked the mutation (TanStack's 'online' network mode) before the offline-aware
 * write could queue it. Under the app's own provider the write now runs and is queued at once.
 */
afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});

describe('offline-aware writes under the app query client', () => {
  it('queues a time entry at once while offline instead of pausing it', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    onlineManager.setOnline(false);
    const fetch = vi.fn(() => Promise.reject(new TypeError('offline')));
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: fetch as unknown as typeof globalThis.fetch,
      readCsrfToken: () => 'csrf',
      newCorrelationId: () => 'c',
    });
    const onLogged = vi.fn();
    render(
      <QueryProvider>
        <LogTimeSheet
          api={client}
          organizationSlug="acme"
          workItemId="w1"
          workTitle="Prepare mobile booking flow"
          projectName="Atlas"
          onClose={() => undefined}
          onLogged={onLogged}
          today={new Date(2026, 10, 18, 9, 0)}
        />
      </QueryProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '30' }));
    fireEvent.click(screen.getByRole('button', { name: 'Log time' }));

    await waitFor(() => expect(onLogged).toHaveBeenCalledWith('queued'));
    expect(fetch).not.toHaveBeenCalled();
  });
});
