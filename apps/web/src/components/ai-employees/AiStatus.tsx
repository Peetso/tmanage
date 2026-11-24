'use client';

import { StatusDot, type StatusTone } from '@tmanage/ui';
import { useTOr } from '../../lib/i18n/use-t-or';
import type { RowStatus } from './ai-employee-model';

const TONE: Readonly<Record<RowStatus, StatusTone>> = {
  active: 'success',
  notConnected: 'neutral',
  paused: 'warning',
  retired: 'neutral',
};

const ENGLISH: Readonly<Record<RowStatus, string>> = {
  active: 'Active',
  notConnected: 'Not connected',
  paused: 'Paused',
  retired: 'Retired',
};

/** The word for a status, for places that need it as text (a phone row, an accessible name). */
export function useStatusWord(): (status: RowStatus) => string {
  const tOr = useTOr();
  return (status) => tOr(`AiPeople.status.${status}`, ENGLISH[status]);
}

/** S1 / S6 status: a dot and its word (never colour alone, WCAG 1.4.1). */
export function AiStatus({
  status,
  className,
}: {
  readonly status: RowStatus;
  readonly className?: string;
}) {
  const word = useStatusWord();
  return (
    <StatusDot
      tone={TONE[status]}
      className={['tm-aie-status', className].filter(Boolean).join(' ')}
    >
      {word(status)}
    </StatusDot>
  );
}
