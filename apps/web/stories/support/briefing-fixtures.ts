import { ApiClient } from '../../src/lib/api/client';
import type { BriefingGroup, BriefingLine, HomeBriefing } from '../../src/lib/api/home-briefing';
import type { HomeWidgetPrefsView } from '../../src/lib/api/home-widget-prefs';

/**
 * 62-A1b (B11) — the Home business briefing as the server answers it, for the story and
 * `tests/home-briefing-card.test.tsx`. Figures from FIGMA-D group b (owner, lead, empty, phone);
 * the demo company is Atlas Studio (fix 33).
 */

export const BRIEFING_NOW = () => new Date('2026-11-19T10:30:00.000Z');
const AS_OF = '2026-11-19T08:00:00.000Z';

let next = 0;
function line(
  patch: Partial<BriefingLine> & Pick<BriefingLine, 'rule' | 'subjectType'>,
): BriefingLine {
  next += 1;
  const subjectId = patch.subjectId ?? `s-${String(next)}`;
  return {
    signalId: `sig-${subjectId}`,
    subjectId,
    projectId: 'proj-1',
    measure: 7,
    threshold: 5,
    title: null,
    context: null,
    amount: null,
    category: null,
    deliverableId: null,
    path: `/work/${subjectId}`,
    ...patch,
  };
}

function group(
  key: BriefingGroup['group'],
  path: string,
  lines: readonly BriefingLine[],
  count = lines.length,
): BriefingGroup {
  return { group: key, count, lines, more: count - lines.length, path };
}

export const BRIEFING_OWNER: HomeBriefing = {
  audience: 'company',
  asOf: AS_OF,
  groups: [
    group(
      'projects_at_risk',
      '/projects/portfolio',
      [
        line({
          rule: 'deadline_at_risk',
          subjectType: 'work_item',
          title: 'Launch kit',
          context: 'Cedar Foods brand refresh',
          measure: 2,
          path: '/work/w-launch',
        }),
        line({
          rule: 'deadline_at_risk',
          subjectType: 'work_item',
          title: 'Beta build',
          context: 'Nile Bank app',
          measure: 4,
        }),
        line({
          rule: 'deadline_at_risk',
          subjectType: 'work_item',
          title: 'Home page',
          context: 'Souq website',
          measure: 6,
        }),
      ],
      5,
    ),
    group('money_to_collect', '/finance/invoices', [
      line({
        rule: 'overdue_invoice',
        subjectType: 'client_invoice',
        title: 'INV-0038',
        context: 'Cedar Foods',
        measure: 12,
        amount: { minor: 420_000, currency: 'USD' },
        path: '/finance/invoices/i-38',
      }),
      line({
        rule: 'overdue_invoice',
        subjectType: 'client_invoice',
        title: 'INV-0035',
        context: 'Nile Bank',
        measure: 5,
        amount: { minor: 275_000, currency: 'USD' },
      }),
    ]),
    group('people_overloaded', '/people/capacity', [
      line({
        rule: 'overloaded_person',
        subjectType: 'membership',
        projectId: null,
        title: 'Omar Adel',
        measure: 115,
        path: '/people/m-omar',
      }),
    ]),
    group(
      'waiting_on_clients',
      '/inbox',
      [
        line({
          rule: 'approval_waiting_on_client',
          subjectType: 'approval',
          title: 'Logo final v3',
          context: 'Cedar Foods brand refresh',
          measure: 5,
          deliverableId: 'd-logo',
          path: '/projects/proj-1/deliverables/d-logo',
        }),
      ],
      4,
    ),
    group('over_budget', '/projects/portfolio', [
      line({
        rule: 'project_over_budget',
        subjectType: 'project',
        title: 'Nile Bank app',
        measure: 112,
        path: '/projects/proj-2',
      }),
    ]),
    group('stale_work', '/work', [
      line({
        rule: 'stale_task',
        subjectType: 'work_item',
        title: 'Footer redesign',
        context: 'Souq website',
        measure: 16,
      }),
    ]),
    group('unusual_expenses', '/finance/expenses', [
      line({
        rule: 'unusual_expense',
        subjectType: 'expense',
        title: 'Stock photos',
        context: 'Souq website',
        measure: 4,
        amount: { minor: 118_000, currency: 'USD' },
        path: '/finance/expenses',
      }),
    ]),
  ],
};

/** A project lead without finance access: their projects only, no money group (frame "lead"). */
export const BRIEFING_LEAD: HomeBriefing = {
  audience: 'team',
  asOf: AS_OF,
  groups: BRIEFING_OWNER.groups.filter(
    (g) =>
      !['money_to_collect', 'money_to_invoice', 'over_budget', 'unusual_expenses'].includes(
        g.group,
      ),
  ),
};

export const BRIEFING_EMPTY: HomeBriefing = { audience: 'company', asOf: AS_OF, groups: [] };

export const BRIEFING_NONE: HomeBriefing = { audience: 'none', asOf: null, groups: [] };

export interface BriefingRoutes {
  /** `null` = the 404 (flag off, client, guest). */
  readonly briefing?: HomeBriefing | null | 'fail' | 'pending';
  readonly prefs?: HomeWidgetPrefsView;
}

function reply(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}

const ERROR = (code: string, status: number) =>
  reply({ error: { code, message: 'Something went wrong.', correlationId: 'c' } }, status);

/** An `ApiClient` answering the briefing and widget-prefs reads; writes are recorded. */
export function briefingClient(
  routes: BriefingRoutes = {},
  writes: { path: string; body: unknown }[] = [],
): ApiClient {
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const path = url.pathname.replace('/v1/organizations/northstar', '');
    if (path === '/home/briefing') {
      const value = routes.briefing === undefined ? BRIEFING_OWNER : routes.briefing;
      if (value === 'pending') return new Promise<Response>(() => undefined);
      if (value === 'fail') return ERROR('internal', 500);
      if (value === null) return ERROR('not_found', 404);
      return reply(value);
    }
    if (path === '/home/widget-prefs') {
      if (init?.method === 'PUT') {
        const body: unknown = JSON.parse(String(init.body));
        writes.push({ path, body });
        return reply(body);
      }
      return reply(routes.prefs ?? { order: [], hidden: [] });
    }
    return reply({});
  }) as typeof globalThis.fetch;

  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-story',
  });
}
