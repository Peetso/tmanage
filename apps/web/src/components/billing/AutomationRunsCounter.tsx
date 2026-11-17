'use client';

import { Badge } from '@tmanage/ui';
import { count } from './plan-usage-format';
import type { PlanStorageText } from './plan-storage-copy';

/**
 * 57-19 (plan 57 §19.2). Automation runs this billing period, for information only: no bar, no
 * limit, nothing is ever stopped for plan reasons. The same row shape as "Clients" on the card.
 */
export function AutomationRunsCounter({
  runs,
  locale,
  tr,
}: {
  runs: number;
  locale: string;
  tr: PlanStorageText;
}) {
  return (
    <div className="tm-pu-meter tm-pu-meter--badge">
      <div className="tm-pu-meter__row">
        <span className="tm-pu-meter__label">{tr('planStorage.runsLabel')}</span>
        <span className="tm-pu-meter__count">
          <Badge>{tr('planStorage.runsBadge')}</Badge>
          <span>{count(runs, locale)}</span>
        </span>
      </div>
      <p className="tm-pu-meter__note">{tr('planStorage.runsNote')}</p>
    </div>
  );
}
