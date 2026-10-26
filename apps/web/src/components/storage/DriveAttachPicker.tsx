'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, InlineAlert } from '@tmanage/ui';
import { getPickerSession, getStorageStatus } from '../../lib/api/google-drive';
import type { ApiClient } from '../../lib/api/client';
import { openDrivePicker, type PickedDriveItem } from '../../lib/google-picker';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useT } from '../../lib/i18n/use-t';
import { DriveProjectFilesDialog } from './DriveProjectFilesDialog';
import '../../styles/screens/storage.css';

export interface DriveAttachPickerProps {
  organizationSlug: string;
  client: ApiClient;
  picked: readonly PickedDriveItem[];
  onPick: (items: readonly PickedDriveItem[]) => void;
  onRemove: (id: string) => void;
  /**
   * The project the new work goes into. The picker token is minted for it (NV10), so the button
   * stays disabled until one is chosen.
   */
  projectId: string;
  disabled?: boolean;
}

/**
 * **Attach from Google Drive** on the New work sheet (Figma 353:15357 / Arabic 353:15392).
 *
 * Shown only when the company has connected Google Drive and the picker is available; otherwise it
 * renders nothing. The picked files are held by the sheet and attached once the work item exists —
 * there is nothing to attach them to before.
 *
 * NV10. A caller who can read every project gets Google's own picker; a project-scoped member
 * gets no Drive token and chooses from the project's TManage folders in
 * {@link DriveProjectFilesDialog} instead. The button and what it hands back are the same.
 */
export function DriveAttachPicker({
  organizationSlug,
  client,
  picked,
  onPick,
  onRemove,
  projectId,
  disabled = false,
}: DriveAttachPickerProps) {
  const t = useT();
  const locale = useActiveLocale();
  const status = useQuery({
    queryKey: ['storage-status', organizationSlug],
    queryFn: () => getStorageStatus(client, organizationSlug),
    staleTime: 60_000,
  });

  const [scopedProject, setScopedProject] = useState<string | null>(null);

  function addFresh(items: readonly PickedDriveItem[]) {
    const known = new Set(picked.map((item) => item.id));
    const fresh = items.filter((item) => !known.has(item.id));
    if (fresh.length > 0) onPick(fresh);
  }

  const pick = useMutation({
    mutationFn: async (): Promise<readonly PickedDriveItem[]> => {
      const session = await getPickerSession(client, organizationSlug, projectId);
      if (session.mode !== 'google') {
        setScopedProject(session.projectId);
        return [];
      }
      return openDrivePicker({
        accessToken: session.accessToken,
        apiKey: session.apiKey,
        appId: session.appId,
        mode: 'files',
        locale,
        title: t('DriveAttach.pickerTitle'),
      });
    },
    onSuccess: addFresh,
  });

  const view = status.data;
  if (!view || !view.pickerAvailable || view.googleDrive.status !== 'connected') return null;

  return (
    <div className="tm-drive-attach">
      <Button
        tone="outline"
        loading={pick.isPending}
        loadingLabel={t('DriveAttach.opening')}
        disabled={disabled || projectId === ''}
        onClick={() => pick.mutate()}
      >
        {t('DriveAttach.button')}
      </Button>
      {picked.length > 0 ? (
        <ul className="tm-drive-attach__list" aria-label={t('DriveAttach.listLabel')}>
          {picked.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="tm-chip tm-chip--compact"
                disabled={disabled}
                onClick={() => onRemove(item.id)}
                aria-label={`${t('DriveAttach.remove')} ${item.name}`}
              >
                <bdi>{item.name}</bdi> ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {scopedProject !== null ? (
        <DriveProjectFilesDialog
          organizationSlug={organizationSlug}
          client={client}
          projectId={scopedProject}
          onPick={addFresh}
          onClose={() => setScopedProject(null)}
        />
      ) : null}
      {pick.isError ? (
        <InlineAlert tone="danger" title={t('DriveAttach.failedTitle')} live>
          {t('DriveAttach.failedBody')}
        </InlineAlert>
      ) : null}
    </div>
  );
}
