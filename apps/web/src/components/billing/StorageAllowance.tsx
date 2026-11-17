'use client';

import { InlineAlert } from '@tmanage/ui';
import type { AlertTone } from '@tmanage/ui';
import type { PlanStorageView, StorageThreshold } from '../../lib/api/plan-usage';
import { HelpTip } from '../help/HelpTip';
import { formatSize } from '../viewer/format-stage-helpers';
import { count, fill } from './plan-usage-format';
import type { PlanStorageCopyKey, PlanStorageText } from './plan-storage-copy';
import { UsageMeter } from './UsageMeter';

const NOTICES: Record<
  Exclude<StorageThreshold, 0>,
  { key: PlanStorageCopyKey; tone: AlertTone }
> = {
  70: { key: 'planStorage.notice70', tone: 'neutral' },
  85: { key: 'planStorage.notice85', tone: 'warning' },
  95: { key: 'planStorage.notice95', tone: 'warning' },
  100: { key: 'planStorage.notice100', tone: 'warning' },
};

/**
 * 57-13r (plan 57 §19.3). The temporary storage allowance on "Where your files live": a bar with
 * the figures in words (and the same sentence for screen readers), hover help on what the space
 * is, and from 70 % a calm notice that names the fix: connect Google Drive or OneDrive (the card's
 * own Connect buttons sit right below). The notice is words, not colour alone.
 */
export function StorageAllowance({
  storage,
  locale,
  tr,
}: {
  storage: PlanStorageView;
  locale: string;
  tr: PlanStorageText;
}) {
  const figures = {
    used: formatSize(storage.used),
    limit: formatSize(storage.limit),
    percent: count(storage.percent, locale),
  };
  const notice = storage.threshold === 0 ? null : NOTICES[storage.threshold];
  return (
    <>
      <HelpTip tip={tr('planStorage.help')} block>
        <div>
          <UsageMeter
            id="transient-storage"
            label={tr('planStorage.label')}
            meter={storage}
            value={fill(tr('planStorage.value'), figures)}
            valueText={fill(tr('planStorage.valueText'), figures)}
            {...(storage.raisedBySupport ? { note: tr('planStorage.raised') } : {})}
          />
        </div>
      </HelpTip>
      {notice === null ? null : (
        <InlineAlert tone={notice.tone}>{fill(tr(notice.key), figures)}</InlineAlert>
      )}
    </>
  );
}
