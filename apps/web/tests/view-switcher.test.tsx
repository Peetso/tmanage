import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  groupByStatus,
  ProjectPortfolioScreen,
} from '../src/components/screens/ProjectPortfolioScreen';
import { ViewSwitcher } from '../src/components/views/ViewSwitcher';
import { workViewHref } from '../src/components/views/WorkViewSwitcher';
import { readViewPreference, viewPreferenceKey } from '../src/components/views/use-view-preference';
import { ApiClient } from '../src/lib/api/client';
import type { ProjectPortfolioSummary } from '../src/lib/api/project-portfolio';
import { describeRow } from '../src/lib/portfolio-presentation';

/**
 * **R38 G5-views** — the shared view switcher (List / Board / Grid / Timeline…) on the list pages:
 * keyboard use, Arabic mirroring, the remembered choice, and the Projects board and grid.
 */

afterEach(() => window.localStorage.clear());

const VIEWS = [
  { id: 'list', label: 'List' },
  { id: 'board', label: 'Board' },
  { id: 'grid', label: 'Grid' },
] as const;
type V = (typeof VIEWS)[number]['id'];

function Harness({ dir }: { dir?: 'rtl' }) {
  const [view, setView] = useState<V>('list');
  return (
    <div dir={dir}>
      <ViewSwitcher label="Projects view" options={VIEWS} value={view} onChange={setView} />
    </div>
  );
}

function summary(
  projectId: string,
  name: string,
  over: Partial<ProjectPortfolioSummary> = {},
): ProjectPortfolioSummary {
  return {
    projectId,
    name,
    status: 'active',
    openWorkCount: 0,
    objectiveCounts: { open: 0, met: 0, missed: 0 },
    latestActivityAt: null,
    committedOn: null,
    forecastOn: null,
    clientName: null,
    ownerName: null,
    clientWaitSince: null,
    startedOn: '2026-09-01',
    archivedAt: null,
    milestones: [],
    ...over,
  };
}

describe('ViewSwitcher', () => {
  it('is one radio group with a single tab stop that the arrow keys move and choose', () => {
    render(<Harness />);
    const group = screen.getByRole('radiogroup', { name: 'Projects view' });
    const list = within(group).getByRole('radio', { name: 'List' });
    expect(list).toHaveAttribute('aria-checked', 'true');
    expect(within(group).getByRole('radio', { name: 'Board' })).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(list, { key: 'ArrowRight' });
    const board = within(group).getByRole('radio', { name: 'Board' });
    expect(board).toHaveAttribute('aria-checked', 'true');
    expect(board).toHaveFocus();

    fireEvent.keyDown(board, { key: 'End' });
    expect(within(group).getByRole('radio', { name: 'Grid' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('follows the reading direction in Arabic: the left arrow moves forward', () => {
    render(<Harness dir="rtl" />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'List' }), { key: 'ArrowLeft' });
    expect(screen.getByRole('radio', { name: 'Board' })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('view preference', () => {
  it('reads back only a view the page offers', () => {
    window.localStorage.setItem(viewPreferenceKey('projects:northstar'), 'grid');
    expect(readViewPreference('projects:northstar', ['list', 'grid'])).toBe('grid');
    window.localStorage.setItem(viewPreferenceKey('projects:northstar'), 'nonsense');
    expect(readViewPreference('projects:northstar', ['list', 'grid'])).toBeNull();
  });
});

describe('work view links', () => {
  it('keep the chosen project on every view', () => {
    expect(workViewHref('northstar', 'board', 'p 1')).toBe(
      '/northstar/work?view=board&project=p+1',
    );
    expect(workViewHref('northstar', 'calendar', '')).toBe('/northstar/work/calendar');
  });
});

describe('Projects board and grid', () => {
  it('groups projects into decision, on-track and archived columns, in that order', () => {
    const now = Date.now();
    const rows = [
      describeRow(summary('p-1', 'Archived one', { status: 'archived' }), now),
      describeRow(summary('p-2', 'Holding', { committedOn: '2099-01-10' }), now),
      describeRow(
        summary('p-3', 'Slipped', { committedOn: '2099-01-01', forecastOn: '2099-01-05' }),
        now,
      ),
    ];
    const groups = groupByStatus(rows);
    expect(groups.map((group) => group.status)).toEqual(['at_risk', 'on_track', 'archived']);
    expect(groups[0]?.rows.map((row) => row.project.name)).toEqual(['Slipped']);
  });

  it('opens on the remembered Grid view and remembers a new choice', async () => {
    window.localStorage.setItem(viewPreferenceKey('projects:northstar'), 'grid');
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((input: RequestInfo | URL) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              String(input).includes('/capacity')
                ? {
                    weekStart: '2026-10-12',
                    disciplines: [],
                    unstaffed: { total: 0, items: [] },
                    constraint: null,
                  }
                : { projects: [summary('p-1', 'Atlas Relaunch')] },
            ),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        )) as typeof globalThis.fetch,
      readCsrfToken: () => 'csrf-token',
      newCorrelationId: () => 'correlation-fixed',
    });
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queries}>
        <ProjectPortfolioScreen
          organizationSlug="northstar"
          organizationName="Northstar"
          client={client}
        />
      </QueryClientProvider>,
    );

    const grid = await screen.findByRole('radio', { name: 'Grid' });
    expect(grid).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('link', { name: 'Atlas Relaunch' }).closest('.tm-view-card')).not.toBe(
      null,
    );

    fireEvent.click(screen.getByRole('radio', { name: 'Board' }));
    expect(window.localStorage.getItem(viewPreferenceKey('projects:northstar'))).toBe('board');
    expect(screen.getByRole('heading', { name: /Needs a decision|On track/ })).toBeInTheDocument();
  });
});
