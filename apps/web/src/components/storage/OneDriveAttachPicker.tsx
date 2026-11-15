'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, InlineAlert } from '@tmanage/ui';
import {
  getOneDrivePickerSession,
  getOneDriveStatus,
  getProjectOneDriveFiles,
} from '../../lib/api/onedrive';
import type { ApiClient } from '../../lib/api/client';
import {
  openOneDrivePicker,
  reservePickerWindow,
  type PickedOneDriveItem,
} from '../../lib/onedrive-picker';
import { formatBytes } from '../../lib/api/uploads';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useT } from '../../lib/i18n/use-t';
import { DriveProjectFilesDialog } from './DriveProjectFilesDialog';
import '../../styles/screens/storage.css';

export interface OneDriveAttachPickerProps {
  organizationSlug: string;
  client: ApiClient;
  picked: readonly PickedOneDriveItem[];
  onPick: (items: readonly PickedOneDriveItem[]) => void;
  onRemove: (itemId: string) => void;
  /** The project the work is in; the picker token is minted for it (NV10). */
  projectId: string;
  disabled?: boolean;
  /** False on the work item, which attaches at once and lists the files in its own card. */
  showList?: boolean;
  /** FIX6 C3: `folder` picks one folder (Microsoft's own picker only); the button says `label`. */
  mode?: 'files' | 'folder';
  label?: string;
}

export const oneDriveStatusKey = (organizationSlug: string) =>
  ['onedrive-status', organizationSlug] as const;

/** The file's extension as the type badge ("XLSX"), or "FILE". */
export function oneDriveFileKind(name: string): string {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(name);
  return match?.[1] ? match[1].toUpperCase() : 'FILE';
}

/** A scoped caller or a failure leaves the reserved popup blank; close it. */
export function closeIfBlank(popup: Window | null): void {
  try {
    if (popup && !popup.closed && popup.location.href === 'about:blank') popup.close();
  } catch {
    // Cross-origin: the picker loaded and closes itself.
  }
}

/**
 * **Attach from OneDrive** (Figma 395:5777 / 395:5811, Arabic 395:6398). Rendered only while the
 * company's OneDrive is connected and the picker is available.
 *
 * NV10. A caller who can read every project gets Microsoft's File Picker v8; a project-scoped
 * member gets no token and chooses from the project's TManage folders instead.
 */
export function OneDriveAttachPicker({
  organizationSlug,
  client,
  picked,
  onPick,
  onRemove,
  projectId,
  disabled = false,
  showList = true,
  mode = 'files',
  label,
}: OneDriveAttachPickerProps) {
  const t = useT();
  const locale = useActiveLocale();
  const status = useQuery({
    queryKey: oneDriveStatusKey(organizationSlug),
    queryFn: () => getOneDriveStatus(client, organizationSlug),
    staleTime: 60_000,
  });
  const [scopedProject, setScopedProject] = useState<string | null>(null);
  const scopedDrive = useRef('');

  function addFresh(items: readonly PickedOneDriveItem[]) {
    const known = new Set(picked.map((item) => item.itemId));
    const fresh = items.filter((item) => !known.has(item.itemId));
    if (fresh.length > 0) onPick(fresh);
  }

  const pick = useMutation({
    mutationFn: async (popup: Window | null): Promise<readonly PickedOneDriveItem[]> => {
      const session = await getOneDrivePickerSession(client, organizationSlug, { projectId });
      if (session.mode !== 'onedrive') {
        // The project-scoped list offers files only; a folder needs Microsoft's own picker.
        if (mode === 'files') setScopedProject(session.projectId);
        return [];
      }
      if (!popup) throw new Error('popup_blocked');
      return openOneDrivePicker({
        popup,
        session,
        mode,
        locale,
        tokenFor: async (resource) => {
          const next = await getOneDrivePickerSession(client, organizationSlug, {
            projectId,
            resource,
          });
          if (next.mode !== 'onedrive') throw new Error('picker_unavailable');
          return next.accessToken;
        },
      });
    },
    onSuccess: addFresh,
    onSettled: (_data, _error, popup) => closeIfBlank(popup),
  });

  const view = status.data;
  if (!view || !view.pickerAvailable || view.oneDrive.status !== 'connected') return null;

  return (
    <div className="tm-onedrive-attach">
      <Button
        tone="outline"
        loading={pick.isPending}
        loadingLabel={t('OneDriveAttach.opening')}
        disabled={disabled || projectId === ''}
        onClick={() => pick.mutate(reservePickerWindow())}
      >
        {label ?? t('OneDriveAttach.button')}
      </Button>
      {showList ? (
        picked.length > 0 ? (
          <div className="tm-onedrive-attach__picked">
            <p className="tm-onedrive-attach__eyebrow">
              {t('OneDriveAttach.fromOneDrive')} ·{' '}
              {picked.length === 1
                ? t('OneDriveAttach.countOne')
                : picked.length === 2
                  ? t('OneDriveAttach.countTwo')
                  : t('OneDriveAttach.countMany').replace('{n}', String(picked.length))}
            </p>
            <ul className="tm-onedrive-attach__list" aria-label={t('OneDriveAttach.listLabel')}>
              {picked.map((item) => (
                <li key={item.itemId} className="tm-onedrive-attach__item">
                  <span className="tm-onedrive-attach__kind" dir="ltr">
                    {oneDriveFileKind(item.name)}
                  </span>
                  <span className="tm-onedrive-attach__text">
                    <bdi className="tm-onedrive-attach__name">{item.name}</bdi>
                    <span className="tm-onedrive-attach__meta">
                      {item.size !== null ? (
                        <>
                          <span dir="ltr">{formatBytes(item.size)}</span> ·{' '}
                        </>
                      ) : null}
                      <bdi>OneDrive</bdi>
                    </span>
                  </span>
                  <button
                    type="button"
                    className="tm-onedrive-attach__remove"
                    disabled={disabled}
                    onClick={() => onRemove(item.itemId)}
                    aria-label={`${t('OneDriveAttach.remove')} ${item.name}`}
                  >
                    {t('OneDriveAttach.remove')}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="tm-onedrive-attach__caption">{t('OneDriveAttach.caption')}</p>
        )
      ) : null}
      {scopedProject !== null ? (
        <DriveProjectFilesDialog
          organizationSlug={organizationSlug}
          client={client}
          projectId={scopedProject}
          provider="onedrive"
          lede={t('OneDriveAttach.dialogLede')}
          listLabel={t('OneDriveAttach.listLabel')}
          loadPage={async (input) => {
            const page = await getProjectOneDriveFiles(
              client,
              organizationSlug,
              scopedProject,
              input,
            );
            scopedDrive.current = page.driveId;
            return {
              folderId: page.folderId,
              files: page.files,
              folders: page.folders.map((folder) => ({
                id: folder.id,
                kind: folder.kind === 'project' ? ('project' as const) : ('work_item' as const),
                name: folder.name,
              })),
              nextPageToken: page.nextPageToken,
            };
          }}
          onPick={(items) =>
            addFresh(
              items.map((item) => ({
                driveId: scopedDrive.current,
                itemId: item.id,
                name: item.name,
                size: null,
                webUrl: null,
              })),
            )
          }
          onClose={() => setScopedProject(null)}
        />
      ) : null}
      {pick.isError ? (
        <InlineAlert tone="danger" title={t('OneDriveAttach.failedTitle')} live>
          {t('OneDriveAttach.failedBody')}
        </InlineAlert>
      ) : null}
    </div>
  );
}
