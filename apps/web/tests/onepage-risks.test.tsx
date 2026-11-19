import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OverviewBlocks } from '../src/components/overview/OverviewBlocks';
import { clientOverviewModel } from '../src/components/overview/client-overview-model';
import { projectOverviewModel } from '../src/components/overview/project-overview-model';
import type { RiskLine } from '../src/components/overview/overview-model';
import {
  CLIENT_SUMMARY,
  OVERVIEW_NOW,
  PROJECT_SIGNALS,
  PROJECT_SUMMARY,
  PROJECT_SUMMARY_WITH_SIGNALS,
} from '../stories/support/overview-fixtures';

/**
 * B10 ONEPAGE-RISKS — the open signals as Risks lines on both one-page screens. The summary has
 * already applied the Home briefing's rule and the `business_briefing` flag; the page draws what
 * came: no signals key is exactly today's block, one line per briefing group with its count, and a
 * fact the block already states is not said twice.
 */
const risksOf = (lines: readonly RiskLine[] | undefined) => lines ?? [];
const signalLines = (lines: readonly RiskLine[]) =>
  lines.flatMap((line) => (line.kind === 'signal' ? [line] : []));

describe('ONEPAGE risks with signals (B10)', () => {
  it('flag off (no signals in the summary): the block is exactly today’s', () => {
    const today = projectOverviewModel(PROJECT_SUMMARY, 'northstar', OVERVIEW_NOW).risks;
    expect(signalLines(risksOf(today?.lines))).toEqual([]);
    const client = clientOverviewModel(CLIENT_SUMMARY, 'northstar', OVERVIEW_NOW).risks;
    expect(signalLines(risksOf(client?.lines))).toEqual([]);
  });

  it('one line per group, its count the summary’s, after the existing lines', () => {
    const today = risksOf(
      projectOverviewModel(PROJECT_SUMMARY, 'northstar', OVERVIEW_NOW).risks?.lines,
    );
    const lines = risksOf(
      projectOverviewModel(PROJECT_SUMMARY_WITH_SIGNALS, 'northstar', OVERVIEW_NOW).risks?.lines,
    );
    expect(lines.slice(0, today.length)).toEqual(today);
    // The fixture's budget line already says the budget used: over budget is not repeated.
    expect(today.some((line) => line.kind === 'budget')).toBe(true);
    expect(signalLines(lines).map((line) => [line.group, line.count])).toEqual([
      ['projects_at_risk', 1],
      ['stale_work', 2],
    ]);
  });

  it('links one signal to its record and many to the project’s work', () => {
    const lines = signalLines(
      risksOf(
        projectOverviewModel(PROJECT_SUMMARY_WITH_SIGNALS, 'northstar', OVERVIEW_NOW).risks?.lines,
      ),
    );
    const href = (group: string) => lines.find((line) => line.group === group)?.href;
    expect(href('projects_at_risk')).toBe('/northstar/work/wi-9');
    expect(href('stale_work')).toBe('/northstar/work?project=proj-1');
  });

  it('says over budget as a signal line where no budget line says it', () => {
    const { budget: _budget, ...withoutBudget } = PROJECT_SUMMARY_WITH_SIGNALS;
    const lines = signalLines(
      risksOf(projectOverviewModel(withoutBudget, 'northstar', OVERVIEW_NOW).risks?.lines),
    );
    expect(lines.find((line) => line.group === 'over_budget')).toMatchObject({
      count: 1,
      threshold: 100,
      href: '/northstar/projects/proj-1',
    });
  });

  it('draws each signal line in words, with the threshold it crossed', () => {
    render(
      <main>
        <OverviewBlocks
          state="ready"
          now={OVERVIEW_NOW}
          deliveryEmpty="work"
          model={projectOverviewModel(PROJECT_SUMMARY_WITH_SIGNALS, 'northstar', OVERVIEW_NOW)}
        />
      </main>,
    );
    const risks = screen.getByRole('region', { name: 'Risks' });
    expect(within(risks).getByText('2 tasks have not moved')).toBeInTheDocument();
    expect(within(risks).getByText('No change for 14 days')).toBeInTheDocument();
    expect(within(risks).getByText('One task may miss its deadline')).toBeInTheDocument();
  });

  it('on the client page the groups add lines, kept to the summary’s paths', () => {
    const lines = signalLines(
      risksOf(
        clientOverviewModel(
          {
            ...CLIENT_SUMMARY,
            signals: {
              asOf: PROJECT_SIGNALS.asOf,
              groups: [
                { group: 'stale_work', count: 3, threshold: 14, path: '/work' },
                { group: 'unusual_expenses', count: 1, threshold: 3, path: '/expenses/e-1' },
              ],
            },
          },
          'northstar',
          OVERVIEW_NOW,
        ).risks?.lines,
      ),
    );
    expect(lines.map((line) => [line.group, line.count, line.href])).toEqual([
      ['stale_work', 3, '/northstar/work'],
      ['unusual_expenses', 1, '/northstar/expenses/e-1'],
    ]);
  });
});
