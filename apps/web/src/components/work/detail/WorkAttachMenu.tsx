'use client';

import { useId, useRef, useState } from 'react';
import { Button } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import type { PickedDriveItem } from '../../../lib/google-picker';
import type { PickedOneDriveItem } from '../../../lib/onedrive-picker';
import { HelpTip } from '../../help/HelpTip';
import { DriveAttachPicker } from '../../storage/DriveAttachPicker';
import { OneDriveAttachPicker } from '../../storage/OneDriveAttachPicker';
import { useA6T } from '../DueDatePicker';
import { useDismiss } from '../use-dismiss';

export interface WorkAttachMenuProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly projectId: string;
  /** A company drive is chosen, so files can be stored: File, Google Drive and OneDrive show. */
  readonly storageReady: boolean;
  readonly busy: boolean;
  readonly onFile: () => void;
  readonly onFigma: () => void;
  readonly onDrive: (picked: readonly PickedDriveItem[]) => void;
  readonly onOneDrive: (picked: readonly PickedOneDriveItem[]) => void;
}

/**
 * The flush "Attach" of the Files section (Figma `WV2-02`, `WV2-09`): one disclosure (WAI-ARIA APG
 * "Disclosure") with every way a file reaches a work: a file from this device, a Figma link, and
 * a file from the company's Google Drive or OneDrive. The two drive entries render nothing while
 * that drive is not connected. The panel stays open while a drive picker or its project-files
 * dialog is up (a press inside a modal is not "outside", {@link useDismiss}) and closes once a
 * file is picked.
 */
export function WorkAttachMenu({
  api,
  organizationSlug,
  projectId,
  storageReady,
  busy,
  onFile,
  onFigma,
  onDrive,
  onOneDrive,
}: WorkAttachMenuProps) {
  const t = useA6T();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const close = (focus: boolean) => {
    setOpen(false);
    if (focus) box.current?.querySelector<HTMLButtonElement>('.tm-wk-attach__trigger')?.focus();
  };
  useDismiss(open, box, (reason) => close(reason === 'escape'));

  return (
    <div ref={box} className="tm-wk-attach">
      <Button
        tone="text"
        size="header"
        flush
        className="tm-wk-attach__trigger"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(!open)}
      >
        {t('WorkFiles.attach')}
      </Button>
      {open ? (
        <div
          id={panelId}
          className="tm-wk-attach__panel"
          role="group"
          aria-label={t('WorkFiles.attachLabel')}
        >
          {storageReady ? (
            <Button
              tone="text"
              onClick={() => {
                close(false);
                onFile();
              }}
            >
              {t('WorkFiles.fromDevice')}
            </Button>
          ) : null}
          <Button
            tone="text"
            onClick={() => {
              close(false);
              onFigma();
            }}
          >
            {t('WorkFiles.figmaLink')}
          </Button>
          {storageReady ? (
            <HelpTip tip={t('CloudImport.tip')}>
              <span className="tm-wk-attach__drives">
                <DriveAttachPicker
                  organizationSlug={organizationSlug}
                  client={api}
                  picked={[]}
                  onPick={(picked) => {
                    close(false);
                    onDrive(picked);
                  }}
                  onRemove={() => undefined}
                  projectId={projectId}
                  disabled={busy}
                  tone="text"
                  label={t('WorkFiles.googleDrive')}
                />
                <OneDriveAttachPicker
                  organizationSlug={organizationSlug}
                  client={api}
                  picked={[]}
                  onPick={(picked) => {
                    close(false);
                    onOneDrive(picked);
                  }}
                  onRemove={() => undefined}
                  projectId={projectId}
                  disabled={busy}
                  showList={false}
                  tone="text"
                  label={t('WorkFiles.oneDrive')}
                />
              </span>
            </HelpTip>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
