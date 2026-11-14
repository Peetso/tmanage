'use client';

import { StateCapsule } from '@tmanage/ui';
import { useT } from '../../lib/i18n/use-t';

/**
 * FIX6 item 1 — the label of a file that passed TManage's own safety checks (its type read from
 * its content, blocked types refused, ZIP and Office files checked inside) but that no virus
 * scanner has judged. Hovering says exactly that; it never claims a virus scan.
 */
export function CheckedLabel() {
  const t = useT();
  return (
    <span className="tm-checked-label" title={t('DownloadScan.checkedHelp')}>
      <StateCapsule state="neutral" glyph="✓" className="tm-scan-capsule">
        {t('DownloadScan.notScanned')}
      </StateCapsule>
    </span>
  );
}
