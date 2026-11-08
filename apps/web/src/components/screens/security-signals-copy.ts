/**
 * 56-23 Security signals (owner) copy — the English each `SecuritySignals.*` key falls back to
 * until the R44 L2 i18n fragment is merged into the catalogs (see `useTOr`).
 */
export const SECURITY_SIGNALS_COPY = {
  crumbSecurity: 'Security',
  title: 'Security signals',
  description:
    'Unusual activity in your company, newest first. Mark a signal reviewed once you have looked at it.',
  loading: 'Loading security signals',
  loadError: 'The security signals could not be loaded',
  reviewError: 'The signal could not be marked reviewed',
  filtersLabel: 'Filter signals',
  notReviewed: 'Not reviewed',
  all: 'All',
  last7: 'Last 7 days',
  last30: 'Last 30 days',
  anyTime: 'Any time',
  empty: 'No signals match. Nothing unusual was detected.',
  tableLabel: 'Security signals',
  colSignal: 'Signal',
  colSeverity: 'Severity',
  colCount: 'Count',
  colLastSeen: 'Last seen',
  colActions: 'Actions',
  severityHigh: 'High',
  severityMedium: 'Medium',
  severityLow: 'Low',
  markReviewed: 'Mark reviewed',
  marking: 'Saving…',
  reviewed: 'Reviewed',
} as const;

export type SecuritySignalsCopyKey = keyof typeof SECURITY_SIGNALS_COPY;
