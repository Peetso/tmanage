import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InsightsPortfolioMobileSummary } from '../src/components/screens/InsightsPortfolioMobileSummary';

/**
 * Module 23's mobile companion for the Insights portfolio. The summary consumes the same roll-up the
 * full screen fetched and renders only the exception digest — three headline figures and the most
 * blocked projects — so the two assertions that matter are: the headline subset is present, and the
 * heavy grid is not.
 */
function flow(blocked: number, itemCount: number) {
  return {
    projectId: 'ignored',
    counts: {
      backlog: 1,
      ready: 0,
      in_progress: 2,
      blocked,
      internal_review: 0,
      done: 1,
      archived: 0,
    },
    itemCount,
    computedAt: '2026-09-20T10:00:00.000Z',
  };
}

function cycle(changesRequested: number) {
  return {
    projectId: 'ignored',
    metrics: {
      approved: { count: 2, decidedCount: 2, totalDurationMs: 0 },
      changes_requested: {
        count: changesRequested,
        decidedCount: changesRequested,
        totalDurationMs: 0,
      },
      invalidated: { count: 0, decidedCount: 0, totalDurationMs: 0 },
    },
    approvalCount: 2 + changesRequested,
    computedAt: '2026-09-20T10:00:00.000Z',
  };
}

const PORTFOLIO = {
  projects: [
    { projectId: 'project-1', name: 'Rebrand', deliveryFlow: flow(3, 7), approvalCycle: cycle(2) },
    { projectId: 'project-2', name: 'Website', deliveryFlow: flow(0, 4), approvalCycle: cycle(0) },
  ],
  projectCount: 2,
  computedAt: '2026-09-20T10:00:00.000Z',
};

const EMPTY = { projects: [], projectCount: 0, computedAt: '2026-09-20T10:00:00.000Z' };

describe('InsightsPortfolioMobileSummary', () => {
  it('renders the headline figures aggregated across the roll-up', () => {
    render(<InsightsPortfolioMobileSummary portfolio={PORTFOLIO} organizationSlug="northstar" />);

    // Projects 2; blocked 3 + 0 = 3; changes requested 2 + 0 = 2 — each figure's value is the
    // `<dd>` next to its `<dt>` label.
    expect(screen.getByText('Projects').nextElementSibling?.textContent).toBe('2');
    expect(screen.getByText('Blocked work items').nextElementSibling?.textContent).toBe('3');
    expect(screen.getByText('Changes requested').nextElementSibling?.textContent).toBe('2');
  });

  it('surfaces the most blocked project as a drill-in link and omits the heavy grid', () => {
    render(<InsightsPortfolioMobileSummary portfolio={PORTFOLIO} organizationSlug="northstar" />);

    const link = screen.getByRole('link', { name: 'Rebrand' });
    expect(link.getAttribute('href')).toBe('/northstar/insights/projects/project-1');
    // Website has zero blocked, so it is not in the attention list.
    expect(screen.queryByRole('link', { name: 'Website' })).toBeNull();
    // The full portfolio table is the thing this view replaces — it must not render here.
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows an empty portfolio plainly — no invented projects', () => {
    render(<InsightsPortfolioMobileSummary portfolio={EMPTY} organizationSlug="northstar" />);

    expect(screen.getByText(/No projects you can read have insights yet/i)).toBeTruthy();
  });
});
