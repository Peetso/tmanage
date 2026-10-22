import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_NAVIGATION,
  INTERNAL_NAVIGATION,
  type NavigationItem,
} from '../src/components/shell/navigation';
import { PlannedInternalScreen } from '../src/components/screens/PlannedInternalScreen';
import { PlannedPortalScreen } from '../src/components/screens/PlannedPortalScreen';
import { expectNoAxeViolations } from './axe';

/**
 * Every destination the two navigations name must resolve to a page.
 *
 * `D12` in `CLAUDE-REVIEW-REPORT.md`: `navigation.ts` exported eight internal and seven client
 * destinations while `apps/web/src/app` held pages for five, so ten links — including the
 * brand link, which `AppShell` points at `/{slug}/home` — reached routes Next answered with a
 * 404. A rail that draws a destination and then cannot open it is a defect the navigation
 * advertises.
 *
 * ## Why the file, not the render
 *
 * In the app router a route resolves exactly when a `page` file exists at its path and 404s
 * when one does not. The href a nav item carries is a suffix under `[orgSlug]`
 * (`AppShell`/`ClientPortalShell` supply the slug), so the file that answers `/home` is
 * `src/app/[orgSlug]/home/page.tsx`. This walk turns each of the sixteen destinations back
 * into that path and asserts the file is there and exports a default — which is precisely what
 * separates a resolving route from a 404. It reads the tree the way `ticket-ids.test.ts` does,
 * from `process.cwd()`, which the config leaves at `apps/web`.
 *
 * It does not start a Next server: this package has no container or browser budget (the vitest
 * config says so), and the existence of the page module is the condition Next itself checks.
 * The two placeholder screens the new pages render are then mounted directly, so the "resolves"
 * proof is paired with a "named and accessible" one.
 */

/** `/portal/deliverables` -> `[orgSlug]/portal/deliverables/page.tsx`. */
function pageFileFor(item: NavigationItem): string {
  const segments = item.href.split('/').filter((segment) => segment.length > 0);
  return join(process.cwd(), 'src', 'app', '[orgSlug]', ...segments, 'page.tsx');
}

const ALL_DESTINATIONS: readonly NavigationItem[] = [...INTERNAL_NAVIGATION, ...CLIENT_NAVIGATION];

describe('every navigation destination resolves to a page', () => {
  it('walks a full navigation, not an empty one', () => {
    // A mapping bug that matched nothing would make every case below vacuously pass.
    // Q1 added the "Clients" internal destination (/clients).
    expect(INTERNAL_NAVIGATION.length).toBe(9);
    // Portal risks (x140) added the "Risks" client destination (/portal/risks).
    expect(CLIENT_NAVIGATION.length).toBe(8);
    expect(ALL_DESTINATIONS.length).toBe(17);
  });

  it.each(ALL_DESTINATIONS.map((item) => [item.label, item] as const))(
    '%s resolves to a page module',
    (_label, item) => {
      const file = pageFileFor(item);
      expect(existsSync(file), `${item.href} has no page at ${file}`).toBe(true);
      expect(readFileSync(file, 'utf8')).toMatch(/export default function/);
    },
  );
});

describe('a planned destination is named and accessible', () => {
  it('gives the internal placeholder one h1 that is the destination name', async () => {
    const { container } = render(
      <PlannedInternalScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        activeNavigationId="calendar"
        title="Calendar"
        description="Dates and commitments across your work."
      >
        Not built yet.
      </PlannedInternalScreen>,
    );

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Calendar');
    await expectNoAxeViolations(container);
  });

  it('gives the portal placeholder one h1 that is the destination name', async () => {
    const { container } = render(
      <PlannedPortalScreen
        organizationSlug="northstar"
        clientName="Atlas Hospitality"
        providerName="Northstar Studio"
        activeNavigationId="files"
        title="Files"
        description="Files shared with you."
        ticket="FILE-003 · WEB-006"
      >
        Not built yet.
      </PlannedPortalScreen>,
    );

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Files');
    await expectNoAxeViolations(container);
  });
});
