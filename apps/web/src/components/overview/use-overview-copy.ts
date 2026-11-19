'use client';

import { useMemo } from 'react';
import { useTOr } from '../../lib/i18n/use-t-or';
import type { OverviewLinkKind } from './overview-model';

/**
 * ONEPAGE — every word the two one-page screens draw, in one place.
 *
 * The keys reach `en.json` / `ar.json` through the wiring step (B04-REPORT, WIRING); until then
 * `tOr` returns the English given here, never a raw key. `{name}`-style holes are filled by
 * `fill`, so a translation may move a value to wherever its language puts it.
 */
export const OVERVIEW_COPY = {
  'Overview.tabsLabel': 'Sections',
  'Overview.tabOverview': 'Overview',
  'Overview.tabWork': 'Work',
  'Overview.tabFiles': 'Files',
  'Overview.tabProjects': 'Projects',
  'Overview.tabPeople': 'People',
  'Overview.backToProjects': 'All projects',
  'Overview.backToClients': 'All clients',
  'Overview.projectsOne': 'One project',
  'Overview.projectsMany': '{count} projects',
  'Overview.ledBy': 'Led by {name}',
  'Overview.dueOn': 'Due {date}',
  'Overview.forecastOn': 'Forecast {date}',
  'Overview.postUpdate': 'Post update',
  'Overview.loading': 'Loading this page',
  'Overview.loadFailed': 'Could not load this. Try again.',
  'Overview.tryAgain': 'Try again',
  'Overview.figuresPartial': 'At least these many: the full list has the rest.',

  'Overview.delivery': 'Delivery',
  'Overview.open': 'Open',
  'Overview.late': 'Late',
  'Overview.done': 'Done',
  'Overview.nextMilestoneDue': 'Next milestone · due {date}',
  'Overview.nextMilestoneUndated': 'Next milestone · no date yet',
  'Overview.deliveryEmpty': 'No work in this yet.',
  'Overview.noProjects': 'No projects shared yet.',
  'Overview.bandBehind': 'Behind',
  'Overview.bandAtRisk': 'At risk',
  'Overview.bandOnTrack': 'On track',

  'Overview.approvals': 'Approvals waiting',
  'Overview.withClient': 'With client',
  'Overview.withTeam': 'With team',
  'Overview.approvalsEmpty': 'No approvals waiting.',

  'Overview.risks': 'Risks',
  'Overview.risksEmpty': 'No risks right now.',
  'Overview.riskLate': 'Late',
  'Overview.riskWatch': 'Watch',
  'Overview.riskLateWorkOne': 'One item is past its due date',
  'Overview.riskLateWorkMany': '{count} items are past their due date',
  'Overview.riskLateWorkMeta': 'Open the work to move or finish them',
  'Overview.riskMilestonesOne': 'One milestone is overdue',
  'Overview.riskMilestonesMany': '{count} milestones are overdue',
  'Overview.riskMilestonesMeta': 'Past its date and not met',
  'Overview.riskHighOne': 'One high risk is open',
  'Overview.riskHighMany': '{count} high risks are open',
  'Overview.riskOpenOne': 'One risk is open',
  'Overview.riskOpenMany': '{count} risks are open',
  'Overview.riskRegisterMeta': 'In the risk register',
  'Overview.riskBudget': '{percent} % of the budget used',
  'Overview.riskBudgetMeta': '{tracked} of {budget} h tracked',
  'Overview.riskStaleOne': 'One approval over {days} days old',
  'Overview.riskStaleMany': '{count} approvals over {days} days old',
  'Overview.riskStaleMeta': 'Oldest: {title}',
  'Overview.riskProjectBehind': '{name} is behind',
  'Overview.riskProjectBehindMeta': 'Project health is red',
  'Overview.riskProjectAtRisk': '{name} needs attention',
  'Overview.riskProjectAtRiskMeta': 'Project health is amber',
  'Overview.riskInvoicesOne': 'One invoice overdue',
  'Overview.riskInvoicesMany': '{count} invoices overdue',

  'Overview.files': 'Latest files',
  'Overview.filesEmpty': 'No files yet.',

  'Overview.time': 'Time',
  'Overview.logged': 'Logged',
  'Overview.billable': 'Billable',
  'Overview.notInvoiced': 'Not invoiced yet',
  'Overview.timeEmpty': 'No time logged yet.',
  'Overview.hours': '{hours} h',

  'Overview.money': 'Money',
  'Overview.invoiced': 'Invoiced · {currency}',
  'Overview.paid': 'Paid · {currency}',
  'Overview.overdue': 'Overdue · {currency}',
  'Overview.unbilled': 'Not invoiced yet · {currency}',
  'Overview.moneyEmpty': 'No invoices yet.',
  'Overview.moreCurrenciesOne': 'Also invoiced in one more currency.',
  'Overview.moreCurrenciesMany': 'Also invoiced in {count} more currencies.',

  'Overview.link.openWork': 'Open work',
  'Overview.link.openProjects': 'Open projects',
  'Overview.link.openApprovals': 'Open approvals',
  'Overview.link.openHealth': 'Open health',
  'Overview.link.seeProjectsAtRisk': 'See projects at risk',
  'Overview.link.openFiles': 'Open files',
  'Overview.link.openTimesheets': 'Open timesheets',
  'Overview.link.openInvoices': 'Open invoices',

  'Overview.atRiskFilter': 'Showing the projects at risk.',
  'Overview.showAllProjects': 'Show all projects',
  'Overview.noProjectsAtRisk': 'No project is at risk.',
} as const;

export type OverviewCopyKey = keyof typeof OVERVIEW_COPY;

export interface OverviewCopy {
  /** The word for a key in the active locale. */
  readonly text: (key: OverviewCopyKey) => string;
  /** The word for a key with its `{holes}` filled. */
  readonly fill: (key: OverviewCopyKey, values: Readonly<Record<string, string>>) => string;
  /** The one or many form of a counted sentence. */
  readonly count: (
    one: OverviewCopyKey,
    many: OverviewCopyKey,
    value: number,
    shown: string,
  ) => string;
  readonly link: (kind: OverviewLinkKind) => string;
}

export function fillHoles(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (hole, name: string) => values[name] ?? hole);
}

export function useOverviewCopy(): OverviewCopy {
  const tOr = useTOr();
  return useMemo(() => {
    const text = (key: OverviewCopyKey) => tOr(key, OVERVIEW_COPY[key]);
    const fill = (key: OverviewCopyKey, values: Readonly<Record<string, string>>) =>
      fillHoles(text(key), values);
    return {
      text,
      fill,
      count: (one, many, value, shown) => (value === 1 ? text(one) : fill(many, { count: shown })),
      link: (kind) => text(`Overview.link.${kind}`),
    };
  }, [tOr]);
}
