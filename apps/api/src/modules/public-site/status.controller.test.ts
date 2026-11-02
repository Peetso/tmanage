import { describe, expect, it } from 'vitest';
import {
  MAX_INCIDENTS,
  PUBLIC_INCIDENT_VIEW_KEYS,
  PublicSiteStatusController,
} from './status.controller.js';
import { PUBLIC_INCIDENT_COLUMNS } from './status.repository.js';
import type { PublicIncidentRow, StatusRepository } from './status.repository.js';
import type { IncidentRow } from '../../common/database/schema.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * x159 — the public status page. Database-free proofs through the `@Public()` controller with a fake
 * repository, mirroring `workload-forecast.controller.test.ts`. The `published = 1` filter and the
 * `started_at desc` order are DB-set in the repository; what this file owns is that the controller's
 * mapping re-holds every boundary (drafts dropped, newest-first, bounded) even if a row reaches it —
 * defence in depth for the public-visibility line — and that the read asks for no session or capability.
 */

function incident(overrides: Partial<IncidentRow>): PublicIncidentRow {
  return {
    id: 'incident-0000-0000-0000-000000000001',
    component: 'API',
    status: 'investigating',
    title: 'Elevated error rate',
    body: 'We are investigating.',
    startedAt: new Date('2026-09-01T00:00:00.000Z'),
    resolvedAt: null,
    published: true,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** A controller wired to a fake identityRead that hands the repository through, over fake rows. */
function controllerWith(rows: readonly PublicIncidentRow[]): PublicSiteStatusController {
  const database = {
    identityRead: async (_options: unknown, work: (runner: unknown) => Promise<unknown>) =>
      work({}),
  } as unknown as TenantDatabase;
  const repository = {
    listPublishedIncidents: async () => rows,
  } as unknown as StatusRepository;
  return new PublicSiteStatusController(database, repository);
}

describe('PublicSiteStatusController.status', () => {
  it('lists published incidents newest-first and excludes drafts — no session or capability', async () => {
    const rows = [
      incident({ id: 'incident-a', startedAt: new Date('2026-09-01T00:00:00.000Z') }),
      incident({ id: 'incident-c', startedAt: new Date('2026-09-03T00:00:00.000Z') }),
      incident({
        id: 'incident-draft',
        published: false,
        startedAt: new Date('2026-09-09T00:00:00.000Z'),
      }),
      incident({ id: 'incident-b', startedAt: new Date('2026-09-02T00:00:00.000Z') }),
    ];

    // Called with no principal and no context: the method takes neither.
    const view = await controllerWith(rows).status();

    expect(view.incidents.map((i) => i.id)).toEqual(['incident-c', 'incident-b', 'incident-a']);
    expect(view.incidents.some((i) => i.id === 'incident-draft')).toBe(false);
    // The newest unresolved published incident drives the overall banner.
    expect(view.overall).toBe('investigating');
    expect(typeof view.asOf).toBe('string');
  });

  it('reports operational when every published incident is resolved', async () => {
    const view = await controllerWith([
      incident({
        id: 'incident-r',
        status: 'resolved',
        resolvedAt: new Date('2026-09-02T00:00:00.000Z'),
      }),
    ]).status();
    expect(view.overall).toBe('operational');
    expect(view.incidents).toHaveLength(1);
    expect(view.incidents[0]?.resolvedAt).toBe('2026-09-02T00:00:00.000Z');
  });

  it('bounds the page to MAX_INCIDENTS', async () => {
    const rows = Array.from({ length: MAX_INCIDENTS + 10 }, (_, i) =>
      incident({ id: `incident-${i}`, startedAt: new Date(2026, 8, 1, 0, 0, i) }),
    );
    const view = await controllerWith(rows).status();
    expect(view.incidents).toHaveLength(MAX_INCIDENTS);
  });

  it('56-13: never leaks an incident-register column, even when a row carries one', async () => {
    // The SQL selects the public columns only — no register column is in the select list.
    expect(Object.keys(PUBLIC_INCIDENT_COLUMNS).sort()).toEqual(
      [...PUBLIC_INCIDENT_VIEW_KEYS, 'published'].sort(),
    );
    // And the mapping drops anything else a row might carry (defence in depth).
    const leaky = incident({
      severity: 'SEV0',
      affectedOrgIdsJson: '["org-secret"]',
      countriesJson: '["SA"]',
      personalData: true,
      createdBy: 'admin-1',
    });
    const view = await controllerWith([leaky]).status();
    expect(Object.keys(view.incidents[0] ?? {})).toEqual([...PUBLIC_INCIDENT_VIEW_KEYS]);
    expect(JSON.stringify(view)).not.toMatch(/SEV0|org-secret|admin-1/u);
  });
});
