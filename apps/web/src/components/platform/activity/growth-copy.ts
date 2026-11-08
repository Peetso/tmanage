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
  emptyBody: 'The nightly job has not produced figures for this period yet.',
} as const;

export type GrowthCopyKey = keyof typeof GROWTH_COPY;
