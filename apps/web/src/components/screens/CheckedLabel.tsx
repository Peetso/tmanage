'use client';

import { StateCapsule } from '@tmanage/ui';
import { useId } from 'react';
import { useT } from '../../lib/i18n/use-t';

/**
 * FIX6 item 1 — the label of a file that passed TManage's own safety checks (its type read from
 * its content, blocked types refused, ZIP and Office files checked inside) but that no virus
 * scanner has judged. Hovering says exactly that; it never claims a virus scan.
 *
 * Review L3: where a client sees the file (`withNote`), "not virus-scanned" is also written out
 * beside the label and tied to it for screen readers, because touch screens never show a hover.
 */
export function CheckedLabel({ withNote = false }: { readonly withNote?: boolean }) {
  const t = useT();
  const noteId = useId();
  return (
    <span
      className="tm-checked-label"
      title={t('DownloadScan.checkedHelp')}
      {...(withNote ? { 'aria-describedby': noteId } : {})}
    >
      <StateCapsule state="neutral" glyph="✓" className="tm-scan-capsule">
        {t('DownloadScan.notScanned')}
      </StateCapsule>
      {withNote ? (
        <span id={noteId} className="tm-checked-label__note">
          {t('DownloadScan.checkedNote')}
        </span>
      ) : null}
    </span>
  );
}
