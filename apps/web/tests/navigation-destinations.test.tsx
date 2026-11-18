import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_NAVIGATION,
  CONTROL_CENTER_NAVIGATION,
  INTERNAL_NAVIGATION,
  MORE_TOOLS_NAVIGATION,
  MORE_WORKSPACE_NAVIGATION,
  type NavigationItem,
} from '../src/components/shell/navigation';
import { PALETTE_SPECS } from '../src/components/shell/command-palette-model';
import { HEALTH_FIX_HREF, STEP_HREF } from '../src/lib/api/getting-started';
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
function pageFileForHref(href: string): string {
  const segments = href.split('/').filter((segment) => segment.length > 0);
  // The palette opens `/organizations` (switch workspace) outside the tenant, as CommandPalette does.
  const tenant = href === '/organizations' ? [] : ['[orgSlug]'];
  return join(process.cwd(), 'src', 'app', ...tenant, ...segments, 'page.tsx');
}

function pageFileFor(item: NavigationItem): string {
  return pageFileForHref(item.href);
}

const ALL_DESTINATIONS: readonly NavigationItem[] = [...INTERNAL_NAVIGATION, ...CLIENT_NAVIGATION];

describe('every navigation destination resolves to a page', () => {
  it('walks a full navigation, not an empty one', () => {
    // A mapping bug that matched nothing would make every case below vacuously pass.
    // Q1 added the "Clients" internal destination (/clients); A10a added "Finance" (/finance).
    // FIX3 item 11 added "Files" (/files, FIL-01).
    expect(INTERNAL_NAVIGATION.length).toBe(11);
    // Portal risks (x140) added the "Risks" client destination (/portal/risks); portal Money
    // (37247fbf) added "Money" (/portal/money).
    expect(CLIENT_NAVIGATION.length).toBe(9);
    expect(ALL_DESTINATIONS.length).toBe(20);
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

/**
 * TESTUX P0 1: the Getting started step "Create a project" pointed at `/projects`, which has no
 * page, so a new owner's first step was a 404. Every other table of in-app links is walked the
 * same way, so a link that names a route nobody built fails here, not in front of a customer.
 */
const OTHER_LINK_TABLES: readonly (readonly [string, string])[] = [
  ...Object.entries(STEP_HREF).map(([step, href]) => [`Getting started ${step}`, href] as const),
  ...Object.entries(HEALTH_FIX_HREF).map(
    ([check, href]) => [`Setup health ${check}`, href] as const,
  ),
  ...PALETTE_SPECS.flatMap((spec) =>
    spec.run.type === 'href' ? [[`Palette ${spec.id}`, spec.run.href] as const] : [],
  ),
  ...[...MORE_WORKSPACE_NAVIGATION, ...MORE_TOOLS_NAVIGATION]
    .filter((item) => item.absolute !== true)
    .map((item) => [`More sheet ${item.id}`, item.href] as const),
  ['Control Center', CONTROL_CENTER_NAVIGATION.href],
];

describe('every other in-app link table resolves to a page', () => {
  it.each(OTHER_LINK_TABLES)('%s (%s) resolves to a page module', (_name, href) => {
    const file = pageFileForHref(href);
    expect(existsSync(file), `${href} has no page at ${file}`).toBe(true);
  });
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
