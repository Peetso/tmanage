import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectOverviewScreen } from '../src/components/screens/ProjectOverviewScreen';
import { OverviewTabs } from '../src/components/overview/OverviewTabs';
import { activeLocale } from '../src/lib/i18n/locale-store';
import {
  OVERVIEW_NOW,
  PROJECT_SUMMARY_NO_FINANCE,
  overviewClient,
  type OverviewRoutes,
} from '../stories/support/overview-fixtures';
import { expectNoAxeViolations } from './axe';

/**
 * ONEPAGE (B04) — the project overview screen (Figma 739:40334): one summary read, the header's
 * owner and dates, the tab row with Work's count, the six blocks, "Post update", a failed read that
 * keeps the page, and the Arabic mount.
 */
function mount(routes: OverviewRoutes = {}) {
  const requests: string[] = [];
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={query}>
      <ProjectOverviewScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        projectId="proj-1"
        client={overviewClient(routes, requests)}
        now={OVERVIEW_NOW}
      />
    </QueryClientProvider>,
  );
  return { ...view, requests };
}

afterEach(() => activeLocale.set('en-US'));

describe('ONEPAGE project overview', () => {
  it('draws the page from one summary read', async () => {
    const { requests } = mount();
    await screen.findByRole('region', { name: 'Money' });
    expect(requests.filter((path) => path.endsWith('/summary'))).toHaveLength(1);
    expect(requests.some((path) => path.includes('/work-items'))).toBe(false);
    for (const name of ['Delivery', 'Approvals waiting', 'Risks', 'Latest files', 'Time']) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
  });

  it('names the owner and the committed date in the header, with the way back first', async () => {
    mount();
    // D4: the client company first, a link to its page, then the lead and the date.
    const company = await screen.findByRole('link', { name: 'Cedar Foods' });
    expect(company).toHaveAttribute('href', '/northstar/clients/co-cedar');
    await waitFor(() =>
      expect(company.parentElement).toHaveTextContent(/^Cedar Foods · Led by Omar Adel · Due/),
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Cedar Foods brand refresh',
    );
    expect(screen.getByRole('link', { name: 'All projects' })).toHaveAttribute(
      'href',
      '/northstar/projects/portfolio',
    );
  });

  it('marks Overview current and counts the open work on the Work tab', async () => {
    mount();
    const tabs = screen.getByRole('navigation', { name: 'Sections' });
    expect(within(tabs).getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const work = await within(tabs).findByRole('link', { name: 'Work 18' });
    expect(work).toHaveAttribute('href', '/northstar/work?project=proj-1');
    // D5: the frame's five tabs, then the other sections behind one "More" menu.
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Overview', 'Work 18', 'Files', 'Time', 'Activity']);
    expect(within(tabs).getByRole('link', { name: 'Time' })).toHaveAttribute(
      'href',
      '/northstar/finance/timesheets',
    );
    const more = within(tabs).getByRole('button', { name: 'More' });
    expect(more).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.click(more);
    const menu = await within(tabs).findByRole('menu', { name: 'More' });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(menu).getByRole('menuitem', { name: 'Milestones' }),
      ),
    );
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Milestones', 'Plan', 'Iterations', 'Team', 'Risks', 'Objectives', 'Stages']);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toHaveTextContent('Plan');
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(within(tabs).queryByRole('menu')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(more);
  });

  it('D5: while a section behind More is the current page, More carries the indicator and names it', () => {
    render(
      <OverviewTabs
        label="Sections"
        current="risks"
        tabs={[{ id: 'overview', label: 'Overview', href: '/o' }]}
        more={{
          label: 'More',
          currentLabel: (name) => `More: ${name}`,
          tabs: [{ id: 'risks', label: 'Risks', href: '/o/risks' }],
        }}
      />,
    );
    const more = screen.getByRole('button', { name: 'More: Risks' });
    expect(more).toHaveAttribute('data-current', 'true');
    fireEvent.click(more);
    expect(screen.getByRole('menuitem', { name: 'Risks' })).toHaveAttribute('aria-current', 'page');
  });

  it('leaves out the Money card and every money figure without finance access', async () => {
    mount({ projectSummary: PROJECT_SUMMARY_NO_FINANCE });
    await screen.findByRole('region', { name: 'Time' });
    expect(screen.queryByRole('region', { name: 'Money' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Not invoiced yet/)).not.toBeInTheDocument();
  });

  it('keeps the header and tabs when the read fails, with one retry card', async () => {
    mount({ projectSummary: 'fail' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this. Try again.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeInTheDocument();
  });

  it('announces a loading page while the read is in flight', () => {
    const { container } = mount({ projectSummary: 'pending' });
    expect(container.querySelectorAll('.tm-ov-card--skeleton')).toHaveLength(6);
  });

  it('opens the update composer from "Post update" and takes focus to it', async () => {
    mount();
    const post = screen.getByRole('button', { name: 'Post update' });
    expect(post).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(post);
    const heading = await screen.findByRole('heading', { name: 'Post an update' });
    expect(post).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('has no axe violations', async () => {
    const { container } = mount();
    await screen.findByRole('region', { name: 'Money' });
    await expectNoAxeViolations(container);
  });

  it('mounts right to left in Arabic', async () => {
    activeLocale.set('ar-EG');
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <div dir="rtl">
        <QueryClientProvider client={query}>
          <ProjectOverviewScreen
            organizationSlug="northstar"
            organizationName="Northstar Studio"
            projectId="proj-1"
            client={overviewClient({})}
            now={OVERVIEW_NOW}
          />
        </QueryClientProvider>
      </div>,
    );
    await waitFor(() =>
      expect(container.querySelectorAll('.tm-ov-card:not(.tm-ov-card--skeleton)')).toHaveLength(6),
    );
    // The back arrow is the mirrored line icon, not a Latin glyph (review FIGMA-C fix 6).
    expect(container.querySelector('.tm-ov-back svg')).not.toBeNull();
    await expectNoAxeViolations(container);
  });
});
