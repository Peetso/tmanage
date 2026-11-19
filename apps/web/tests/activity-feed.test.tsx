import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ActivityFeed,
  groupByDay,
  type ActivityFeedRow,
} from '../src/components/screens/ActivityFeed';
import { ClientCompanyScreen } from '../src/components/screens/ClientCompanyScreen';
import { ProjectOverviewScreen } from '../src/components/screens/ProjectOverviewScreen';
import {
  activityEntryHref,
  activityQueryFor,
  filterKindsFor,
} from '../src/components/overview/activity-tab-model';
import { parseClientView, parseProjectView } from '../src/components/overview/overview-links';
import { activeLocale } from '../src/lib/i18n/locale-store';
import {
  ACTIVITY_EMPTY,
  ACTIVITY_PAGE,
  ACTIVITY_PAGE_2,
  ACTIVITY_PAGE_NO_FINANCE,
  OVERVIEW_NOW,
  overviewClient,
  type OverviewRoutes,
} from '../stories/support/overview-fixtures';
import { expectNoAxeViolations } from './axe';

/**
 * 62-A2 (B09) — the one activity feed and the Activity tab of the project and client pages
 * (FIGMA-D 753:41712 / 753:42457 / 753:43120, client 754:42228 / 754:43001; review fixes 1–10):
 * day groups, rows as links, loading / failed / empty / nothing-matches, kind chips as one choice,
 * the Person menu, "Load more", money absent without finance, axe and the Arabic mount.
 */

const NOW = new Date(2026, 10, 19, 12, 0);
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute).toISOString();

function row(
  id: string,
  occurredAt: string,
  extra: Partial<ActivityFeedRow> = {},
): ActivityFeedRow {
  return {
    id,
    occurredAt,
    actor: { name: 'Omar Adel', client: false },
    sentence: `Omar Adel — ${id}`,
    ...extra,
  };
}

describe('ActivityFeed', () => {
  it('groups newest-first rows under Today, Yesterday and the day', () => {
    const groups = groupByDay(
      [row('a', at(19, 10)), row('b', at(19, 9)), row('c', at(18, 17)), row('d', at(14, 16))],
      NOW,
      { today: 'Today', yesterday: 'Yesterday' },
      () => '14 November',
    );
    expect(groups.map((group) => [group.label, group.rows.map((item) => item.id)])).toEqual([
      ['Today', ['a', 'b']],
      ['Yesterday', ['c']],
      ['14 November', ['d']],
    ]);
  });

  it('makes a row with a target one link, and leaves a row without one plain', () => {
    render(
      <ActivityFeed
        title="Activity"
        now={NOW}
        empty={null}
        state={{
          status: 'ready',
          rows: [
            row('linked', at(19, 10), { href: '/northstar/work/wi-7', meta: ['Work'] }),
            row('plain', at(19, 9)),
          ],
        }}
      />,
    );
    const link = screen.getByRole('link', { name: /Omar Adel — linked/ });
    expect(link).toHaveAttribute('href', '/northstar/work/wi-7');
    expect(link).toHaveTextContent('· Work');
    expect(screen.queryByRole('link', { name: /plain/ })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Today' })).toBeInTheDocument();
  });

  it('shows six skeleton rows while loading and a retry when the read fails', () => {
    const onRetry = vi.fn();
    const { container, rerender } = render(
      <ActivityFeed title="Activity" now={NOW} empty={null} state={{ status: 'loading' }} />,
    );
    expect(container.querySelectorAll('[aria-busy="true"] > *')).toHaveLength(6);
    rerender(
      <ActivityFeed title="Activity" now={NOW} empty={null} state={{ status: 'error', onRetry }} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load activity. Try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('keeps the rows shown while more load, with a busy button', () => {
    render(
      <ActivityFeed
        title="Activity"
        now={NOW}
        empty={null}
        state={{ status: 'ready', rows: [row('a', at(19, 10))] }}
        more={{ hasMore: true, busy: true, failed: false, onMore: () => undefined }}
      />,
    );
    expect(screen.getByText('Omar Adel — a')).toBeInTheDocument();
    // The visible label stays (no resize under the pointer); the wait is announced and inert.
    const button = screen.getByRole('button', { name: /Load more|Loading…/ });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Showing 1')).toBeInTheDocument();
  });
});

describe('Activity tab model', () => {
  it('offers the Money chip only with finance access', () => {
    expect(filterKindsFor(true)).toContain('money');
    expect(filterKindsFor(false)).not.toContain('money');
  });

  it('sends "Last 30 days" as today and the 29 days before it', () => {
    expect(activityQueryFor({ kind: 'files', person: 'user-2', period: '30' }, NOW)).toEqual({
      kind: 'files',
      person: 'user-2',
      from: '2026-10-21',
    });
    expect(activityQueryFor({ kind: null, person: null, period: 'any' }, NOW)).toEqual({});
  });

  it('links each entry to the record it names', () => {
    const [work, file, time, invoice, project] = ACTIVITY_PAGE.entries;
    expect(activityEntryHref('northstar', work!)).toBe('/northstar/work/wi-7');
    expect(activityEntryHref('northstar', file!)).toBe('/northstar/files/file-3');
    expect(activityEntryHref('northstar', time!)).toBe('/northstar/finance/timesheets');
    expect(activityEntryHref('northstar', invoice!)).toBe('/northstar/finance/invoices/inv-42');
    expect(activityEntryHref('northstar', project!)).toBe('/northstar/projects/proj-1');
  });

  it('reads the Activity tab from ?view= on both pages', () => {
    expect(parseProjectView('activity')).toBe('activity');
    expect(parseProjectView('nonsense')).toBe('overview');
    expect(parseClientView('activity')).toBe('activity');
  });
});

function mountProject(routes: OverviewRoutes = {}) {
  const requests: string[] = [];
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={query}>
      <ProjectOverviewScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        projectId="proj-1"
        view="activity"
        client={overviewClient(routes, requests)}
        now={OVERVIEW_NOW}
      />
    </QueryClientProvider>,
  );
  return { ...view, requests };
}

const activityReads = (requests: readonly string[]) =>
  requests.filter((path) => path.startsWith('/projects/proj-1/activity'));

afterEach(() => activeLocale.set('en-US'));

describe('Activity tab on the project page', () => {
  it('marks the Activity tab current and draws the entries as links', async () => {
    mountProject();
    const tabs = screen.getByRole('navigation', { name: 'Sections' });
    expect(within(tabs).getByRole('link', { name: 'Activity' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const line = await screen.findByRole('link', {
      name: /Omar Adel — Changed the status of a task/,
    });
    expect(line).toHaveAttribute('href', '/northstar/work/wi-7');
    expect(line).toHaveTextContent('· Work');
    expect(screen.getByRole('link', { name: /Lina Saeed — Uploaded a file/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Sent an invoice/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Money' })).toBeInTheDocument();
  });

  it('has no Money chip and no money line without finance access', async () => {
    mountProject({ activity: ACTIVITY_PAGE_NO_FINANCE, capabilities: ['work.read'] });
    await screen.findByRole('link', { name: /Changed the status of a task/ });
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Work' })).toBeInTheDocument());
    expect(screen.queryByRole('radio', { name: 'Money' })).not.toBeInTheDocument();
    const feed = screen.getByRole('region', { name: 'Activity' });
    expect(within(feed).queryByText(/invoice/i)).not.toBeInTheDocument();
    expect(screen.getByText('Showing 4')).toBeInTheDocument();
  });

  it('asks for one kind when a chip is chosen, as a single choice with a check', async () => {
    const { requests } = mountProject();
    await screen.findByRole('link', { name: /Changed the status of a task/ });
    const files = screen.getByRole('radio', { name: 'Files' });
    fireEvent.click(files);
    await waitFor(() =>
      expect(activityReads(requests).some((path) => path.includes('kind=files'))).toBe(true),
    );
    expect(files).toHaveAttribute('aria-checked', 'true');
    expect(files.querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'false');
  });

  it('filters by person from the Person menu', async () => {
    const { requests } = mountProject();
    await screen.findByRole('link', { name: /Changed the status of a task/ });
    const chip = screen.getByRole('button', { name: 'Person: Anyone' });
    expect(chip).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.click(chip);
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Lina Saeed' }));
    await waitFor(() =>
      expect(activityReads(requests).some((path) => path.includes('person=user-2'))).toBe(true),
    );
    expect(screen.getByRole('button', { name: 'Person: Lina Saeed' })).toBeInTheDocument();
  });

  it('says nothing matches, with Clear filters, when a filter finds nothing', async () => {
    const { requests } = mountProject({
      activity: (search) => (search.get('kind') ? ACTIVITY_EMPTY : ACTIVITY_PAGE),
    });
    await screen.findByRole('link', { name: /Changed the status of a task/ });
    fireEvent.click(screen.getByRole('radio', { name: 'Approvals' }));
    expect(await screen.findByText('Nothing matches these filters.')).toBeInTheDocument();
    expect(screen.queryByText('No activity yet')).not.toBeInTheDocument();
    const clear = screen.getAllByRole('button', { name: 'Clear filters' });
    fireEvent.click(clear[clear.length - 1]!);
    await screen.findByRole('link', { name: /Changed the status of a task/ });
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true');
    expect(activityReads(requests).length).toBeGreaterThanOrEqual(2);
  });

  it('says no activity yet with "Go to work" when nothing happened', async () => {
    mountProject({ activity: ACTIVITY_EMPTY });
    expect(await screen.findByRole('heading', { name: 'No activity yet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to work' })).toHaveAttribute(
      'href',
      '/northstar/work?project=proj-1',
    );
  });

  it('loads the next page behind "Load more" and keeps the rows already shown', async () => {
    const { requests } = mountProject();
    await screen.findByText('Showing 5');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('link', { name: /Approved a version/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Changed the status of a task/ })).toBeInTheDocument();
    expect(screen.getByText('Showing 6')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(activityReads(requests).some((path) => path.includes('cursor=cursor-2'))).toBe(true);
  });

  it('keeps the header and tabs when the read fails', async () => {
    mountProject({ activity: 'fail' });
    expect(await screen.findByText('Could not load activity. Try again.')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = mountProject();
    await screen.findByRole('link', { name: /Changed the status of a task/ });
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
            view="activity"
            client={overviewClient({})}
            now={OVERVIEW_NOW}
          />
        </QueryClientProvider>
      </div>,
    );
    await waitFor(() => expect(container.querySelectorAll('.tm-act__item')).toHaveLength(5));
    await expectNoAxeViolations(container);
  });
});

describe('Activity tab on the client page', () => {
  function mountClient(routes: OverviewRoutes = {}) {
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={query}>
        <ClientCompanyScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          clientOrganizationId="co-cedar"
          view="activity"
          client={overviewClient(routes)}
          now={() => OVERVIEW_NOW.getTime()}
        />
      </QueryClientProvider>,
    );
  }

  it("names each line's project in the meta line", async () => {
    mountClient();
    const line = await screen.findByRole('link', { name: /Sent an invoice/ });
    await waitFor(() => expect(line).toHaveTextContent('· Ramadan campaign 2027 · Money'));
  });

  it('offers "Open projects" when a client with projects has no activity', async () => {
    mountClient({ activity: ACTIVITY_EMPTY });
    expect(await screen.findByRole('heading', { name: 'No activity yet' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Open projects' })).toHaveAttribute(
        'href',
        '/northstar/clients/co-cedar?view=projects',
      ),
    );
  });

  it('reads the client route, not the project one', async () => {
    const requests: string[] = [];
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={query}>
        <ClientCompanyScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          clientOrganizationId="co-cedar"
          view="activity"
          client={overviewClient({ activity: ACTIVITY_PAGE_2 }, requests)}
          now={() => OVERVIEW_NOW.getTime()}
        />
      </QueryClientProvider>,
    );
    await screen.findByRole('link', { name: /Approved a version/ });
    expect(
      requests.some((path) => path.startsWith('/client-organizations/co-cedar/activity')),
    ).toBe(true);
    expect(requests.some((path) => path.startsWith('/projects/proj-1/activity'))).toBe(false);
  });
});
