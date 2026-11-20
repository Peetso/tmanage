import { useCallback } from 'react';
import { useTOr } from '../../../lib/i18n/use-t-or';

/**
 * 57-09 Growth copy — the English each `PlatformGrowth.*` key falls back to until the R44 L2 i18n
 * fragment is merged into the catalogs (see `useTOr`).
 */
export const GROWTH_COPY = {
  title: 'Growth',
  description: 'Sign-ups, activation and retention across all companies, from the nightly figures.',
  periodLabel: 'Period',
  month: 'Month',
  week: 'Week',
  downloadCsv: 'Download CSV',
  kpiLabel: 'Growth figures',
  signups: 'Sign-ups',
  inRange: 'in range',
  activation: 'Activation',
  within7: 'within 7 days',
  clientActivation: 'Client activation',
  within14: 'within 14 days',
  firstProject: 'First project',
  median: 'median',
  hours: 'h',
  noData: 'No data yet',
  signupsByMonth: 'Sign-ups by month',
  signupsByWeek: 'Sign-ups by week',
  activationSteps: 'Activation steps',
  step_org: 'Created a company',
  step_project: 'First project',
  step_invites_3: 'Invited 3 people',
  step_work_items_10: '10 work items',
  step_converted_message: 'Turned a message into work',
  step_completed_work: 'Finished work',
  retentionTitle: 'Weekly retention by sign-up week',
  colWeek: 'Week',
  colPeople: 'People',
  weekShort: 'W',
  emptyTitle: 'No growth figures yet',
  // GROWTH-FIX: honest about what happens next, and about stale figures (no promise it cannot keep).
  emptyBody:
    'The figures are worked out in the background, usually within an hour of the app starting. If this page stays empty, the background job is not running.',
  updatedAt: 'Figures as of {date}.',
  staleBody:
    'These figures were last updated on {date} and have not been refreshed since, so the newest sign-ups are missing.',
  // ── 62-A3 (B14) · Figma 758:43241 EN / 758:43432 AR ──
  periodHint: 'Sets the period of the sign-up figures below.',
  sectionActivation: 'Activation',
  sectionAi: 'AI',
  sectionMoney: 'Money',
  weeklyActive: 'Weekly active companies',
  weeklyActiveSub: 'with 2 or more internal people active this week',
  weeklyActiveSubWeekOf: 'with 2 or more internal people active in the week of {week}',
  weeklyActiveOf: '{active} of {total} companies',
  firstProjectFinished: 'First project finished',
  firstProjectSub: 'of sign-ups finished a first project within 30 days',
  within60: '{percent} % within 60 days',
  timeToOutcome: 'Time to first outcome',
  timeToOutcomeSub: 'median, from sign-up to the first approval or invoice',
  days: 'days',
  aiTasksRun: 'AI tasks run',
  aiTasksFinished: 'AI tasks finished',
  aiCreditsUsed: 'AI credits used',
  aiNoDataSub: 'Counted once a company turns AI on',
  aiThisMonth: 'this month',
  aiCreditsOf: '{used} of {cap} credits this month',
  costPerCompany: 'Cost per active company',
  costPerCompanySub: 'this month: AI plus hosting and mail',
  notSet: 'Not set',
  notSetSub: 'Enter the unit costs in Platform settings to see this.',
  setUnitCosts: 'Set unit costs',
  noActiveCompanies: 'No active companies this month yet.',
  margin: 'Margin',
  marginBeta: 'Not available in the free beta',
  marginBetaSub: 'Shown once paid plans start.',
  marginNotSetSub: 'Needs the unit costs from Platform settings.',
  marginNoRevenue: 'No revenue this month yet.',
  marginSub: 'this month: revenue less running costs',
} as const;

export type GrowthCopyKey = keyof typeof GROWTH_COPY;

export type GrowthCopy = (key: GrowthCopyKey) => string;

/** The Growth page's copy in the active locale, English until the catalogs carry the key. */
export function useGrowthCopy(): GrowthCopy {
  const tOr = useTOr();
  return useCallback((key: GrowthCopyKey) => tOr(`PlatformGrowth.${key}`, GROWTH_COPY[key]), [tOr]);
}

/** `{name}` placeholders filled in, for copy that carries a figure. */
export function fillCopy(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}
