import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PortalJourneyStepper } from '../src/components/screens/PortalJourneyStepper';
import { ApiClient } from '../src/lib/api/client';

/** 52-27 — the stepper opens each client step kind on its existing screen. */
function apiWith(journey: unknown): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify({ journey }), {
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

const step = (id: string, kind: string, state: string) => ({
  id,
  kind,
  title: `Step ${id}`,
  dueOn: null,
  state,
  missed: false,
});

describe('52-27 journey step kinds in the stepper', () => {
  it.each([
    ['form', 's2', '/acme/portal/journey/s2'],
    ['sign', 'req-1', '/acme/portal/sign/req-1'],
    ['meeting', 'm-1', '/acme/portal/meetings/m-1'],
    ['upload', null, '/acme/portal/files'],
  ])('a %s turn links to its screen', async (kind, targetId, href) => {
    const journey = {
      projectId: 'p1',
      steps: [step('s1', 'form', 'done'), step('s2', kind, 'now')],
      yourTurn: { kind, stepId: 's2', title: 'Step s2', targetId },
      completed: false,
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PortalJourneyStepper
          api={apiWith(journey)}
          organizationSlug="acme"
          projectId="p1"
          providerName="Studio"
        />
      </QueryClientProvider>,
    );
    const heading = await screen.findByRole('heading', { name: 'Step s2' });
    expect(heading).toBeTruthy();
    const action = screen.getAllByRole('link').find((link) => link.getAttribute('href') === href);
    expect(action).toBeTruthy();
  });
});
