import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppShell } from '../src/components/shell/AppShell';
import { ClientPortalShell } from '../src/components/shell/ClientPortalShell';
import { IdentityShell } from '../src/components/shell/IdentityShell';
import { OnboardingShell } from '../src/components/shell/OnboardingShell';
import { CLIENT_NAVIGATION, INTERNAL_NAVIGATION } from '../src/components/shell/navigation';
import { expectNoAxeViolations } from './axe';

/**
 * The four shells.
 *
 * `A11Y-01` in `27-TEST-CATALOG` is the specification these assertions come from: a skip
 * link, a `<main>`, one `<h1>`, and navigation that says which destination is current. They
 * are asserted on the shells rather than on each of the nine screens because that is where
 * the guarantee lives — a screen cannot omit a landmark it does not render.
 */

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
    renderShell();
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
    const current = screen.getByRole('link', { name: 'Work' });
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
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

  it('leads with the client, and names the delivery team beneath', () => {
    renderShell();
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
    const { rerender } = renderShell(false);
    expect(screen.queryByText('Client preview')).toBeNull();

    rerender(
      <ClientPortalShell
        organizationSlug="northstar"
        clientName="Atlas Hospitality"
        providerName="Northstar Studio"
        title="Deliverables"
        preview
      >
        <p>Portal canvas</p>
      </ClientPortalShell>,
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
  it('renders the mark, the screen id and a main landmark', () => {
    render(
      <IdentityShell screenId="ID-01" eyebrow="Sign in" footer={<a href="/legal">Privacy</a>}>
        <h1>Sign in</h1>
      </IdentityShell>,
    );

    expect(screen.getByRole('img', { name: 'TManage' })).toBeInTheDocument();
    expect(screen.getByText(/ID-01/)).toBeInTheDocument();
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
