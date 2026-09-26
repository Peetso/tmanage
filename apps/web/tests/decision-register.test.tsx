import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { DecisionRegisterScreen } from '../src/components/screens/DecisionRegisterScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * **DEC-01 Decision register (x113).**
 *
 * The tenant-scoping, ordering and the Known-trap 404s are proved over fakes and a real server in
 * `apps/api/src/modules/decisions/decisions.service.test.ts` and
 * `apps/api/test/dec-001-decisions.db.test.ts`; nothing here re-proves them.
 *
 * What only this file can prove is what the *screen* does: it renders the server's order without
 * re-sorting, authors a decision through `POST …/decisions` and refetches the register, shows the
 * empty state plainly, and carries an accessible form and list (labelled regions, a caption, column
 * headers) with no axe violation jsdom can detect.
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function clientOver(handler: (call: Call) => Response): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: (init?.method ?? 'GET').toUpperCase(),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      return Promise.resolve(handler(call));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, calls };
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

const PROJECT_ID = 'proj-1';

function decision(id: string, title: string, decidedAt: string, status = 'accepted') {
  return {
    id,
    projectId: PROJECT_ID,
    meetingId: null,
    title,
    statement: 'because',
    status,
    decidedBy: 'user-1',
    decidedAt,
    createdAt: decidedAt,
  };
}

describe('DecisionRegisterScreen', () => {
  it('renders the register in server order and is accessible', async () => {
    const { client } = clientOver((call) => {
      if (call.url.includes('/decisions'))
        return json({
          decisions: [
            decision('d-2', 'Later decision', '2026-06-01T09:00:00.000Z'),
            decision('d-1', 'Earlier decision', '2026-01-01T09:00:00.000Z'),
          ],
        });
      if (call.url.includes('/projects'))
        return json({ projects: [{ id: PROJECT_ID, name: 'Northstar' }] });
      return json({}, 404);
    });

    const { container } = render(
      withQuery(
        <DecisionRegisterScreen
          organizationSlug="acme"
          organizationName="Acme"
          initialProjectId={PROJECT_ID}
          client={client}
        />,
      ),
    );

    const region = await screen.findByRole('region', { name: /decision register/i });
    const table = within(region).getByRole('table');
    const bodyRows = within(table).getAllByRole('row').slice(1);
    expect(bodyRows).toHaveLength(2);
    // Server order preserved: the later decision leads.
    expect(within(bodyRows[0]!).getByRole('rowheader')).toHaveTextContent('Later decision');
    expect(within(bodyRows[1]!).getByRole('rowheader')).toHaveTextContent('Earlier decision');

    await expectNoAxeViolations(container);
  });

  it('records a decision and refetches the register', async () => {
    let created = false;
    const { client, calls } = clientOver((call) => {
      if (call.method === 'POST' && call.url.includes('/decisions')) {
        created = true;
        return json(
          decision(
            'd-new',
            String((call.body as { title: string }).title),
            '2026-07-01T00:00:00.000Z',
          ),
          201,
        );
      }
      if (call.url.includes('/decisions'))
        return json({
          decisions: created
            ? [decision('d-new', 'Adopt the plan', '2026-07-01T00:00:00.000Z')]
            : [],
        });
      if (call.url.includes('/projects'))
        return json({ projects: [{ id: PROJECT_ID, name: 'Northstar' }] });
      return json({}, 404);
    });

    render(
      withQuery(
        <DecisionRegisterScreen
          organizationSlug="acme"
          organizationName="Acme"
          initialProjectId={PROJECT_ID}
          client={client}
        />,
      ),
    );

    // Empty state first.
    expect(await screen.findByText(/no decisions yet/i)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^Decision/i), 'Adopt the plan');
    await user.type(screen.getByLabelText(/in words/i), 'We will adopt the plan.');
    await user.click(screen.getByRole('button', { name: /record decision/i }));

    // The POST carried the authored fields.
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST');
      expect(post?.body).toMatchObject({
        projectId: PROJECT_ID,
        title: 'Adopt the plan',
        statement: 'We will adopt the plan.',
        status: 'proposed',
      });
    });

    // The register refetches and shows the new decision.
    expect(await screen.findByRole('rowheader', { name: /adopt the plan/i })).toBeInTheDocument();
  });

  it('accepts a proposed decision through PATCH and refetches', async () => {
    let accepted = false;
    const { client, calls } = clientOver((call) => {
      if (call.method === 'PATCH' && call.url.includes('/decisions/')) {
        accepted = true;
        return json(decision('d-1', 'Adopt the plan', '2026-07-01T00:00:00.000Z', 'accepted'));
      }
      if (call.url.includes('/decisions'))
        return json({
          decisions: [
            decision(
              'd-1',
              'Adopt the plan',
              '2026-07-01T00:00:00.000Z',
              accepted ? 'accepted' : 'proposed',
            ),
          ],
        });
      if (call.url.includes('/projects'))
        return json({ projects: [{ id: PROJECT_ID, name: 'Northstar' }] });
      return json({}, 404);
    });

    render(
      withQuery(
        <DecisionRegisterScreen
          organizationSlug="acme"
          organizationName="Acme"
          initialProjectId={PROJECT_ID}
          client={client}
        />,
      ),
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^accept$/i }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH');
      expect(patch?.url).toContain('/decisions/d-1');
      expect(patch?.body).toMatchObject({ status: 'accepted' });
    });
  });

  it('supersedes a decision by another through POST and refetches', async () => {
    let superseded = false;
    const { client, calls } = clientOver((call) => {
      if (call.method === 'POST' && call.url.includes('/supersede')) {
        superseded = true;
        return json({
          ...decision('d-old', 'The old way', '2026-07-01T00:00:00.000Z', 'superseded'),
          supersededBy: { decisionId: 'd-new', at: '2026-07-02T00:00:00.000Z' },
          supersedes: [],
        });
      }
      if (call.url.includes('/decisions'))
        return json({
          decisions: [
            decision('d-new', 'The new way', '2026-07-02T00:00:00.000Z', 'accepted'),
            decision(
              'd-old',
              'The old way',
              '2026-07-01T00:00:00.000Z',
              superseded ? 'superseded' : 'proposed',
            ),
          ],
        });
      if (call.url.includes('/projects'))
        return json({ projects: [{ id: PROJECT_ID, name: 'Northstar' }] });
      return json({}, 404);
    });

    render(
      withQuery(
        <DecisionRegisterScreen
          organizationSlug="acme"
          organizationName="Acme"
          initialProjectId={PROJECT_ID}
          client={client}
        />,
      ),
    );

    const user = userEvent.setup();
    const oldRow = await screen.findByRole('row', { name: /the old way/i });
    await user.selectOptions(within(oldRow).getByLabelText(/supersede with/i), 'd-new');
    await user.click(within(oldRow).getByRole('button', { name: /^supersede$/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.includes('/supersede'));
      expect(post?.url).toContain('/decisions/d-old/supersede');
      expect(post?.body).toMatchObject({ supersededById: 'd-new' });
    });
  });
});
