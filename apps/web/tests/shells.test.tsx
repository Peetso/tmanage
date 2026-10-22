import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { translate, type MessageKey } from '../src/lib/i18n/t';
import { AppShell } from '../src/components/shell/AppShell';
import { ClientPortalShell } from '../src/components/shell/ClientPortalShell';
import { IdentityShell } from '../src/components/shell/IdentityShell';
import { OnboardingShell } from '../src/components/shell/OnboardingShell';
import { CLIENT_NAVIGATION, INTERNAL_NAVIGATION } from '../src/components/shell/navigation';
import { expectNoAxeViolations } from './axe';

// The open account menu reads the router for sign-out; jsdom has no Next app router.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

/**
 * The four shells.
 *
 * `A11Y-01` in `27-TEST-CATALOG` is the specification these assertions come from: a skip
 * link, a `<main>`, one `<h1>`, and navigation that says which destination is current. They
 * are asserted on the shells rather than on each of the nine screens because that is where
 * the guarantee lives — a screen cannot omit a landmark it does not render.
 *
 * The names in the header come from the session's organization list, not the prop (CQ-03 dropped
 * the design's sample-company fallback). The assertions about the shown name therefore seed that
 * list through a `QueryClientProvider`; the landmark/navigation assertions keep rendering the bare
 * shell, which needs no client.
 */

/** Seeds the shell's organization list so the header resolves the real name instead of blanking it. */
function withSeededOrg(children: ReactNode, summary: Record<string, unknown>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['shell', 'organizations'], [summary]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The provider's own org row behind the portal: its `name` is the delivery team, `clientOrganizationName` the client. */
const PORTAL_ORG = {
  id: 'o1',
  slug: 'northstar',
  name: 'Northstar Studio',
  audience: 'client',
  role: 'client',
  clientOrganizationName: 'Atlas Hospitality',
};

describe('AppShell', () => {
  function renderShell() {
    return render(
      <AppShell
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        activeNavigationId="work"
        title="Work"
      >
        <p>Canvas</p>
      </AppShell>,
    );
  }

  it('renders a skip link that points at the main landmark', () => {
    renderShell();
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skip).toHaveAttribute('href', '#tm-main');
    expect(document.getElementById('tm-main')?.tagName).toBe('MAIN');
  });

  it('renders exactly one first-level heading', () => {
    renderShell();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('names the organization on every screen it wraps', () => {
    render(
      withSeededOrg(
        <AppShell
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          activeNavigationId="work"
          title="Work"
        >
          <p>Canvas</p>
        </AppShell>,
        {
          id: 'o1',
          slug: 'northstar',
          name: 'Northstar Studio',
          audience: 'internal',
          role: 'owner',
          clientOrganizationName: null,
        },
      ),
    );
    expect(screen.getByText('Northstar Studio')).toBeInTheDocument();
  });

  it('offers every internal destination as a real link, under the organization', () => {
    renderShell();
    const rail = screen.getByRole('navigation', { name: 'Primary' });
    for (const item of INTERNAL_NAVIGATION) {
      expect(within(rail).getByRole('link', { name: item.label })).toHaveAttribute(
        'href',
        `/northstar${item.href}`,
      );
    }
    // The brand orb too. Nothing in the rail is org-less: from WEB-001 until 2026-09-03 every
    // item was, and pointed at a route that does not exist.
    expect(within(rail).getByRole('link', { name: 'TManage home' })).toHaveAttribute(
      'href',
      '/northstar/home',
    );
    for (const link of within(rail).getAllByRole('link')) {
      expect(link.getAttribute('href')?.startsWith('/northstar/')).toBe(true);
    }
  });

  it('marks the current destination for assistive technology, not only with colour', () => {
    renderShell();
    // Scoped to the rail: the mobile dock (Module 23) also renders Work and Home, so the two
    // navigations each carry the state and an unscoped query would match both.
    const rail = screen.getByRole('navigation', { name: 'Primary' });
    const current = within(rail).getByRole('link', { name: 'Work' });
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(within(rail).getByRole('link', { name: 'My Day' })).not.toHaveAttribute('aria-current');
  });

  it('renders the context rail and the lens only when they are given', () => {
    const { rerender } = renderShell();
    expect(screen.queryByRole('navigation', { name: 'Within this section' })).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Details' })).toBeNull();

    rerender(
      <AppShell
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        title="Work"
        contextRail={<p>Saved views</p>}
        lens={<p>Detail</p>}
      >
        <p>Canvas</p>
      </AppShell>,
    );
    expect(screen.getByRole('navigation', { name: 'Within this section' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Details' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderShell();
    await expectNoAxeViolations(container);
  });
});

describe('ClientPortalShell', () => {
  function renderShell(preview = false) {
    return render(
      <ClientPortalShell
        organizationSlug="northstar"
        clientName="Atlas Hospitality"
        providerName="Northstar Studio"
        projectName="Website relaunch"
        activeNavigationId="deliverables"
        title="Deliverables"
        preview={preview}
      >
        <p>Portal canvas</p>
      </ClientPortalShell>,
    );
  }

  it('carries the same account menu as the internal shell', () => {
    renderShell();
    const en = (key: string) => translate('en-US', `AccountMenu.${key}` as MessageKey);
    fireEvent.click(screen.getByRole('button', { name: en('trigger') }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: en('accessTokens') })).toHaveAttribute(
      'href',
      '/northstar/settings/security',
    );
    expect(within(menu).getByRole('menuitem', { name: en('signOut') })).toBeInTheDocument();
  });

  it('leads with the client, and names the delivery team beneath', () => {
    render(
      withSeededOrg(
        <ClientPortalShell
          organizationSlug="northstar"
          clientName="Atlas Hospitality"
          providerName="Northstar Studio"
          projectName="Website relaunch"
          activeNavigationId="deliverables"
          title="Deliverables"
        >
          <p>Portal canvas</p>
        </ClientPortalShell>,
        PORTAL_ORG,
      ),
    );
    expect(screen.getByText('Atlas Hospitality')).toBeInTheDocument();
    expect(screen.getByText(/Delivered by Northstar Studio/)).toBeInTheDocument();
  });

  it('says it is a client portal', () => {
    renderShell();
    expect(screen.getByText('Client portal')).toBeInTheDocument();
  });

  /**
   * The assertion this file exists for. The portal is a separate space, not the internal
   * shell with items hidden — so no internal destination can appear in it, whatever anyone
   * adds to `INTERNAL_NAVIGATION` later.
   */
  it('offers no internal destination', () => {
    renderShell();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const hrefs = within(nav)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'));

    // Every destination is the portal's, under this organization's slug. The prefix arrived
    // with `WEB-004`: the portal is tenant-scoped like every other screen, so its links are.
    expect(hrefs).toEqual(CLIENT_NAVIGATION.map((item) => `/northstar${item.href}`));
    for (const href of hrefs) {
      expect(href?.startsWith('/northstar/portal')).toBe(true);
    }
    for (const internal of INTERNAL_NAVIGATION) {
      expect(hrefs).not.toContain(internal.href);
    }
  });

  it('shows the preview bar only when an internal person asked for it', () => {
    const { rerender } = render(
      withSeededOrg(
        <ClientPortalShell
          organizationSlug="northstar"
          clientName="Atlas Hospitality"
          providerName="Northstar Studio"
          activeNavigationId="deliverables"
          title="Deliverables"
          preview={false}
        >
          <p>Portal canvas</p>
        </ClientPortalShell>,
        PORTAL_ORG,
      ),
    );
    expect(screen.queryByText('Client preview')).toBeNull();

    rerender(
      withSeededOrg(
        <ClientPortalShell
          organizationSlug="northstar"
          clientName="Atlas Hospitality"
          providerName="Northstar Studio"
          title="Deliverables"
          preview
        >
          <p>Portal canvas</p>
        </ClientPortalShell>,
        PORTAL_ORG,
      ),
    );
    expect(screen.getByText('Client preview')).toBeInTheDocument();
    expect(screen.getByText(/what Atlas Hospitality sees/i)).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderShell();
    await expectNoAxeViolations(container);
  });
});

describe('IdentityShell', () => {
  it('renders the mark, the human eyebrow and a main landmark — and no internal screen code', () => {
    render(
      <IdentityShell screenId="ID-01" eyebrow="Sign in" footer={<a href="/legal">Privacy</a>}>
        <h1>Sign in</h1>
      </IdentityShell>,
    );

    expect(screen.getByRole('img', { name: 'TManage' })).toBeInTheDocument();
    // TXT-01: the screen id ("ID-01") used to sit in the eyebrow beside the mark and read as an
    // internal build label to people signing in. The eyebrow now shows only its human label.
    expect(screen.queryByText(/ID-01/)).toBeNull();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Privacy' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <IdentityShell screenId="ID-01" eyebrow="Sign in">
        <h1>Sign in</h1>
      </IdentityShell>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('OnboardingShell', () => {
  function renderShell(current: 'ON-01' | 'ON-02' | 'ON-03' | 'ON-04') {
    return render(
      <OnboardingShell current={current} signedInAs="omar@northstar.studio" title="Step">
        <p>Body</p>
      </OnboardingShell>,
    );
  }

  it('marks the current step for assistive technology', () => {
    renderShell('ON-02');
    const steps = screen.getAllByRole('listitem');
    const current = steps.filter((step) => step.getAttribute('aria-current') === 'step');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('Operating template');
  });

  /**
   * The token export's third law — every state that uses colour also carries a word — applied
   * to progress. A row of coloured circles tells a non-visual reader nothing.
   */
  it('says "done", "current step" and "not started" in text', () => {
    renderShell('ON-03');
    const steps = screen.getAllByRole('listitem');
    expect(steps[0]).toHaveTextContent('done');
    expect(steps[2]).toHaveTextContent('current step');
    expect(steps[3]).toHaveTextContent('not started');
  });

  it('counts the steps in words as well as in shape', () => {
    renderShell('ON-03');
    expect(screen.getByText('Step 3 of 4')).toBeInTheDocument();
  });

  /**
   * ACC-08: a skippable step that is behind the current one was marked "done" even when it had
   * been skipped. The required first step is still "done" once passed; a skipped one says so,
   * and a caller that recorded it as completed gets "done" back.
   */
  it('distinguishes a skipped earlier step from a done one', () => {
    renderShell('ON-04');
    const steps = screen.getAllByRole('listitem');
    expect(steps[0]).toHaveTextContent('done'); // ON-01 is required, so passing it means done
    expect(steps[1]).toHaveTextContent('not done or skipped'); // ON-02 was skippable, not recorded
    expect(steps[1]).not.toHaveTextContent('— done');
  });

  it('marks a recorded skippable step as done', () => {
    render(
      <OnboardingShell current="ON-04" signedInAs="o@n.studio" title="Step" completed={['ON-02']}>
        <p>Body</p>
      </OnboardingShell>,
    );
    const steps = screen.getAllByRole('listitem');
    expect(steps[1]).toHaveTextContent('done');
  });

  /** Nothing in the sequence can be jumped to, so nothing in it is a link. */
  it('renders no step as a link', () => {
    renderShell('ON-01');
    const nav = screen.getByRole('navigation', { name: 'Setup progress' });
    expect(within(nav).queryAllByRole('link')).toHaveLength(0);
  });

  it('has no axe violations', async () => {
    const { container } = renderShell('ON-01');
    await expectNoAxeViolations(container);
  });
});
