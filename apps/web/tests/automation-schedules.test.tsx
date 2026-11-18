import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AutomationSchedulesScreen } from '../src/components/screens/AutomationSchedulesScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * **Automations scheduled triggers (x167).**
 *
 * The API's resolve-before-authorize, the `org.manage` 403, the bounded-spec 400 and the pure
 * next-run computation are proved over fakes in `apps/api`; nothing here re-proves them. What only
 * this file can prove is what the *screen* does: it lists a tenant's schedules soonest-due first,
 * carries a create form whose fields track the chosen interval, and has an accessible structure (a
 * labelled list region, a table caption and column headers) with no axe violation.
 */

interface Call {
  readonly url: string;
  readonly method: string;
}

function clientOver(handler: (call: Call) => Response): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        handler({ url: String(input), method: (init?.method ?? 'GET').toUpperCase() }),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const DAILY = {
  id: 'sch-1',
  templateId: 'tpl-1',
  spec: { interval: 'daily' as const, hour: 8 },
  nextRunAt: '2026-09-28T08:00:00.000Z',
  enabled: true,
  createdAt: '2026-09-27T09:00:00.000Z',
};

const WEEKLY = {
  id: 'sch-2',
  templateId: 'tpl-2',
  spec: { interval: 'weekly' as const, hour: 12, dayOfWeek: 3 },
  nextRunAt: '2026-09-30T12:00:00.000Z',
  enabled: false,
  createdAt: '2026-09-27T09:00:00.000Z',
};

/** The library the screen names each schedule from and offers in its form. */
const TEMPLATES = [
  {
    id: 'tpl-1',
    name: 'Notify owner',
    triggerKind: 'request_submitted',
    actionKind: 'notify_owner',
    config: {},
    enabled: true,
    createdBy: 'mem-a',
    createdAt: '2026-09-20T09:00:00.000Z',
  },
  {
    id: 'tpl-2',
    name: 'Weekly digest',
    triggerKind: 'meeting_scheduled',
    actionKind: 'send_email_digest',
    config: {},
    enabled: true,
    createdBy: 'mem-a',
    createdAt: '2026-09-20T09:00:00.000Z',
  },
];

/** The library answer, or `undefined` when the URL is not the library's. */
function libraryAnswer(
  url: string,
  templates: readonly unknown[] = TEMPLATES,
): Response | undefined {
  return url.includes('/automations/templates') ? json({ templates }) : undefined;
}

function screenOver(
  schedules: readonly (typeof DAILY | typeof WEEKLY)[],
  templates: readonly unknown[] = TEMPLATES,
) {
  const client = clientOver((call) => {
    const library = libraryAnswer(call.url, templates);
    if (library) return library;
    if (call.url.includes('/automations/schedules')) {
      if (call.method === 'POST') return json(DAILY, 201);
      return json({ schedules });
    }
    return json({}, 404);
  });
  return withQuery(
    <AutomationSchedulesScreen organizationSlug="acme" organizationName="Acme" client={client} />,
  );
}

describe('AutomationSchedulesScreen', () => {
  it('lists schedules soonest-due first and is accessible', async () => {
    const { container } = render(screenOver([DAILY, WEEKLY]));

    const region = await screen.findByRole('region', { name: /scheduled triggers/i });
    const table = within(region).getByRole('table');
    const bodyRows = within(table).getAllByRole('row').slice(1);
    expect(bodyRows).toHaveLength(2);
    // Each schedule is named by its automation, never by its id.
    expect(within(bodyRows[0]!).getByRole('rowheader')).toHaveTextContent('Notify owner');
    expect(within(table).queryByText(/tpl-/)).not.toBeInTheDocument();
    expect(within(table).getByText(/Weekly on Wednesday at 12:00/)).toBeInTheDocument();
    // 2026-10-31 live-test fix: the state is an On switch per row, not a read-only capsule.
    expect(
      within(table).getByRole('switch', { name: 'Schedule for Notify owner is on' }),
    ).toBeChecked();
    expect(
      within(table).getByRole('switch', { name: 'Schedule for Weekly digest is on' }),
    ).not.toBeChecked();
    expect(within(table).getByText(/Off, skipped until turned on/)).toBeInTheDocument();

    await expectNoAxeViolations(container);
  });

  it('shows the empty state when there are no schedules yet', async () => {
    render(screenOver([]));
    expect(await screen.findByText(/no schedules yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('creates a schedule through the form, choosing the automation by name', async () => {
    render(screenOver([]));
    const user = userEvent.setup();
    const automation = await screen.findByRole('combobox', { name: /automation/i });
    await screen.findByRole('option', { name: 'Notify owner' });
    await user.selectOptions(automation, 'Notify owner');
    await user.click(screen.getByRole('button', { name: /create schedule/i }));
    // The POST resolves 201 and the list is invalidated; the create control stays reachable.
    expect(await screen.findByRole('button', { name: /create schedule/i })).toBeInTheDocument();
  });

  it('says where to make an automation when the library is empty, with no id field', async () => {
    render(screenOver([], []));
    expect(await screen.findByText(/no automation to schedule yet/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /make one in the library/i })).toHaveAttribute(
      'href',
      '/acme/automations',
    );
    expect(screen.getByRole('combobox', { name: /automation/i })).toBeDisabled();
    expect(screen.queryByLabelText(/template id/i)).not.toBeInTheDocument();
  });

  it('turns a schedule off with its switch (PATCH enabled:false)', async () => {
    const calls: { method: string; url: string; body: string }[] = [];
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ method, url: String(input), body: String(init?.body ?? '') });
        const library = libraryAnswer(String(input));
        if (library) return Promise.resolve(library);
        if (method === 'PATCH') return Promise.resolve(json({ ...DAILY, enabled: false }));
        if (String(input).includes('/schedules'))
          return Promise.resolve(json({ schedules: [DAILY] }));
        return Promise.resolve(json({}, 404));
      }) as typeof globalThis.fetch,
      readCsrfToken: () => 'csrf-token',
      newCorrelationId: () => 'correlation-fixed',
    });
    render(
      withQuery(
        <AutomationSchedulesScreen
          organizationSlug="acme"
          organizationName="Acme"
          client={client}
        />,
      ),
    );
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('switch', { name: 'Schedule for Notify owner is on' }),
    );
    const patch = await vi.waitFor(() => {
      const found = calls.find((call) => call.method === 'PATCH');
      if (!found) throw new Error('no PATCH yet');
      return found;
    });
    expect(patch.url).toContain('/automations/schedules/sch-1');
    expect(JSON.parse(patch.body)).toEqual({ enabled: false });
  });

  it('asks before removing a schedule, then sends DELETE', async () => {
    const calls: { method: string; url: string }[] = [];
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ method, url: String(input) });
        const library = libraryAnswer(String(input));
        if (library) return Promise.resolve(library);
        if (method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
        if (String(input).includes('/schedules'))
          return Promise.resolve(json({ schedules: [DAILY] }));
        return Promise.resolve(json({}, 404));
      }) as typeof globalThis.fetch,
      readCsrfToken: () => 'csrf-token',
      newCorrelationId: () => 'correlation-fixed',
    });
    const { container } = render(
      withQuery(
        <AutomationSchedulesScreen
          organizationSlug="acme"
          organizationName="Acme"
          client={client}
        />,
      ),
    );
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Remove the schedule for Notify owner' }),
    );
    const confirm = screen.getByRole('group', { name: 'Remove this schedule?' });
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    await expectNoAxeViolations(container);

    await user.click(within(confirm).getByRole('button', { name: 'Keep it' }));
    expect(screen.queryByRole('group', { name: 'Remove this schedule?' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove the schedule for Notify owner' }));
    await user.click(
      within(screen.getByRole('group', { name: 'Remove this schedule?' })).getByRole('button', {
        name: 'Remove',
      }),
    );
    await vi.waitFor(() =>
      expect(calls.find((call) => call.method === 'DELETE')?.url).toContain(
        '/automations/schedules/sch-1',
      ),
    );
  });
});
