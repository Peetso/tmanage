import { describe, expect, it } from 'vitest';
import { projectOverviewModel } from '../src/components/overview/project-overview-model';
import { clientOverviewModel } from '../src/components/overview/client-overview-model';
import { riskSeverity } from '../src/components/overview/overview-model';
import {
  CLIENT_SUMMARY,
  CLIENT_SUMMARY_NO_FINANCE,
  OVERVIEW_NOW,
  PROJECT_SUMMARY,
  PROJECT_SUMMARY_EMPTY,
  PROJECT_SUMMARY_NO_FINANCE,
} from '../stories/support/overview-fixtures';

/**
 * ONEPAGE (B04) — the two pure mappers from a summary read to the six blocks. Absence is the
 * server's: a block the summary left out stays out; money facts need the finance block (review
 * FIGMA-C fix 1); the milestone capsule comes from project health (fix 3).
 */
describe('projectOverviewModel', () => {
  it('maps every block of a full summary, figures equal to the summary', () => {
    const model = projectOverviewModel(PROJECT_SUMMARY, 'northstar', OVERVIEW_NOW);
    expect(Object.keys(model)).toEqual([
      'delivery',
      'approvals',
      'risks',
      'files',
      'time',
      'money',
    ]);
    expect(model.delivery).toMatchObject({ open: 18, late: 3, done: 41, complete: true });
    expect(model.delivery?.link.href).toBe('/northstar/work?project=proj-1');
    expect(model.time).toMatchObject({
      loggedMinutes: 7560,
      billableMinutes: 6720,
      unbilledMinutes: 2280,
    });
    expect(model.money).toMatchObject({ currency: 'AED', invoicedMinor: 4_800_000 });
  });

  it('takes the next milestone capsule from project health, never a fixed value', () => {
    const model = projectOverviewModel(PROJECT_SUMMARY, 'northstar', OVERVIEW_NOW);
    expect(model.delivery?.rows).toEqual([
      expect.objectContaining({ kind: 'nextMilestone', title: 'Packaging artwork', band: 'amber' }),
    ]);
    const { health: _health, ...noHealth } = PROJECT_SUMMARY;
    const without = projectOverviewModel(noHealth, 'northstar', OVERVIEW_NOW);
    expect(without.delivery?.rows[0]).not.toHaveProperty('band');
  });

  it('lists the risk lines with their reasons, late before watch', () => {
    const lines = projectOverviewModel(PROJECT_SUMMARY, 'northstar', OVERVIEW_NOW).risks?.lines;
    expect(lines?.map((line) => line.kind)).toEqual([
      'lateWork',
      'highRisks',
      'budget',
      'staleApprovals',
    ]);
    expect(lines?.map(riskSeverity)).toEqual(['late', 'watch', 'watch', 'watch']);
    expect(lines?.[3]).toMatchObject({ count: 1, oldestTitle: 'Label artwork v3' });
  });

  it('without finance: no Money block and no money fact anywhere else', () => {
    const model = projectOverviewModel(PROJECT_SUMMARY_NO_FINANCE, 'northstar', OVERVIEW_NOW);
    expect(model.money).toBeUndefined();
    expect(model.time).not.toHaveProperty('unbilledMinutes');
    expect(model.risks?.lines.some((line) => line.kind === 'budget')).toBe(false);
    // Budget readable (project.manage) but finance not: still no budget line.
    const budgetOnly = projectOverviewModel(
      { ...PROJECT_SUMMARY_NO_FINANCE, budget: PROJECT_SUMMARY.budget! },
      'northstar',
      OVERVIEW_NOW,
    );
    expect(budgetOnly.risks?.lines.some((line) => line.kind === 'budget')).toBe(false);
  });

  it('keeps empty blocks present and drops only absent ones', () => {
    const empty = projectOverviewModel(PROJECT_SUMMARY_EMPTY, 'northstar', OVERVIEW_NOW);
    expect(Object.keys(empty)).toEqual([
      'delivery',
      'approvals',
      'risks',
      'files',
      'time',
      'money',
    ]);
    expect(empty.risks?.lines).toEqual([]);
    expect(empty.delivery?.rows).toEqual([]);
    expect(empty.money?.currency).toBeNull();

    const bare = projectOverviewModel(
      { project: PROJECT_SUMMARY.project },
      'northstar',
      OVERVIEW_NOW,
    );
    expect(bare).toEqual({});
  });

  it('calls a budget at or over 100 % late', () => {
    const over = projectOverviewModel(
      { ...PROJECT_SUMMARY, budget: { ...PROJECT_SUMMARY.budget!, percentBp: 10_400 } },
      'northstar',
      OVERVIEW_NOW,
    );
    const line = over.risks?.lines.find((entry) => entry.kind === 'budget');
    expect(line && riskSeverity(line)).toBe('late');
  });
});

describe('clientOverviewModel', () => {
  it('orders the delivery rows at risk first and names each approval and file by project', () => {
    const model = clientOverviewModel(CLIENT_SUMMARY, 'northstar', OVERVIEW_NOW);
    expect(model.delivery?.rows.map((row) => row.kind === 'project' && row.name)).toEqual([
      'Ramadan campaign 2027',
      'Cedar Foods brand refresh',
    ]);
    expect(model.approvals?.items[2]).toMatchObject({ context: 'Ramadan campaign 2027' });
    expect(model.files?.items[1]).toMatchObject({ context: 'Ramadan campaign 2027' });
    expect(model.delivery?.link.href).toBe('/northstar/clients/co-cedar?view=projects');
  });

  it('opens the projects at risk from the risks card (review fix 9)', () => {
    const model = clientOverviewModel(CLIENT_SUMMARY, 'northstar', OVERVIEW_NOW);
    expect(model.risks?.link).toEqual({
      kind: 'seeProjectsAtRisk',
      href: '/northstar/clients/co-cedar?view=projects&health=at-risk',
    });
    expect(model.risks?.lines.map((line) => line.kind)).toEqual([
      'projectBehind',
      'projectAtRisk',
      'overdueInvoices',
      'staleApprovals',
    ]);
  });

  it('shows the client money in its leading currency', () => {
    expect(clientOverviewModel(CLIENT_SUMMARY, 'northstar', OVERVIEW_NOW).money).toMatchObject({
      currency: 'AED',
      invoicedMinor: 9_600_000,
      paidMinor: 7_800_000,
      overdueMinor: 600_000,
      overdueCount: 1,
      moreCurrencies: 0,
    });
  });

  it('without finance: no Money, no Time, no overdue invoice line', () => {
    const model = clientOverviewModel(CLIENT_SUMMARY_NO_FINANCE, 'northstar', OVERVIEW_NOW);
    expect(model.money).toBeUndefined();
    expect(model.time).toBeUndefined();
    expect(model.risks?.lines.some((line) => line.kind === 'overdueInvoices')).toBe(false);
  });
});
