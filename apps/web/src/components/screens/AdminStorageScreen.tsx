'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Checkbox,
  InlineAlert,
  LoadingRegion,
  Select,
  Skeleton,
  StateCapsule,
} from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  completeDriveConnect,
  disconnectDrive,
  getPickerSession,
  getStorageStatus,
  readDriveReturn,
  startDriveConnect,
  updateStorageSettings,
} from '../../lib/api/google-drive';
import type { DriveLocation, StorageMode, StorageStatusView } from '../../lib/api/google-drive';
import type { ApiClient } from '../../lib/api/client';
import { openDrivePicker } from '../../lib/google-picker';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useOrganizationName } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';
import '../../styles/screens/storage.css';

export interface AdminStorageScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Control > Storage** (Figma ADM-14 · Storage: not configured 353:1172, connected 353:1296,
 * error 353:1450). Where this company's files live: TManage storage (the default) or the
 * company's Google Drive, in `TManage/<Project>/<Work item>/`.
 *
 * Connecting goes to Google's consent screen and comes back here; the API forwards Google's answer
 * in the URL fragment, and this screen completes the connection under the person's own session,
 * then clears the fragment. Every action is behind `org.manage` on the API.
 */
export function AdminStorageScreen({
  organizationSlug,
  organizationName: passedOrganizationName,
  client,
}: AdminStorageScreenProps) {
  const organizationName = useOrganizationName(organizationSlug, passedOrganizationName);
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const t = useT();
  const locale = useActiveLocale();
  const queryKey = ['storage-status', organizationSlug];
  const [returnError, setReturnError] = useState(false);
  const handledReturn = useRef(false);

  const status = useQuery({ queryKey, queryFn: () => getStorageStatus(api, organizationSlug) });
  const store = (view: StorageStatusView) => queries.setQueryData(queryKey, view);

  const complete = useMutation({
    mutationFn: (input: { code: string; state: string }) =>
      completeDriveConnect(api, organizationSlug, input),
    onSuccess: store,
  });

  // Google's answer comes back in the fragment; handle it once, then remove it from the address.
  useEffect(() => {
    if (handledReturn.current || typeof window === 'undefined') return;
    handledReturn.current = true;
    const returned = readDriveReturn(window.location.hash);
    if (!returned) return;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    if (returned.kind === 'error') setReturnError(true);
    else complete.mutate({ code: returned.code, state: returned.state });
  }, [complete]);

  const connect = useMutation({
    mutationFn: () => startDriveConnect(api, organizationSlug),
    onSuccess: ({ url }) => window.location.assign(url),
  });

  const settings = useMutation({
    mutationFn: (input: { storageMode?: StorageMode; location?: DriveLocation }) =>
      updateStorageSettings(api, organizationSlug, input),
    onSuccess: store,
  });

  const disconnect = useMutation({
    mutationFn: () => disconnectDrive(api, organizationSlug),
    onSuccess: store,
  });

  const changeFolder = useMutation({
    mutationFn: async () => {
      const session = await getPickerSession(api, organizationSlug);
      const [folder] = await openDrivePicker({
        ...session,
        mode: 'folder',
        locale,
        title: t('AdminStorageScreen.pickFolderTitle'),
      });
      if (!folder) return null;
      return updateStorageSettings(api, organizationSlug, {
        location: { kind: 'folder', folderId: folder.id },
      });
    },
    onSuccess: (view) => {
      if (view) store(view);
    },
  });

  const failed =
    returnError ||
    complete.isError ||
    connect.isError ||
    settings.isError ||
    disconnect.isError ||
    changeFolder.isError;
  const busy =
    complete.isPending ||
    connect.isPending ||
    settings.isPending ||
    disconnect.isPending ||
    changeFolder.isPending;

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="storage"
      crumbs={[t('AdminStorageScreen.crumb')]}
      title={t('AdminStorageScreen.title')}
    >
      {status.isPending ? (
        <LoadingRegion label={t('AdminStorageScreen.loading')}>
          <Skeleton height="320px" radius="var(--r-card)" />
        </LoadingRegion>
      ) : status.isError ? (
        <InlineAlert tone="danger" title={t('AdminStorageScreen.loadError')}>
          {t('AdminStorageScreen.tryAgain')}
        </InlineAlert>
      ) : (
        <section className="tm-storage" aria-labelledby="tm-storage-heading">
          <h2 id="tm-storage-heading" className="tm-visually-hidden">
            {t('AdminStorageScreen.title')}
          </h2>
          <p className="tm-storage__intro">{t('AdminStorageScreen.intro')}</p>

          {failed ? (
            <InlineAlert tone="danger" title={t('AdminStorageScreen.actionFailedTitle')} live>
              {t('AdminStorageScreen.actionFailedBody')}
            </InlineAlert>
          ) : null}

          <div
            className="tm-storage__options"
            role="group"
            aria-label={t('AdminStorageScreen.optionsLabel')}
          >
            <div className="tm-storage__option">
              <Checkbox
                className="tm-storage__choice"
                label={t('AdminStorageScreen.tmanageTitle')}
                hint={t('AdminStorageScreen.tmanageBody')}
                checked={status.data.storageMode === 'tmanage'}
                disabled={busy || status.data.storageMode === 'tmanage'}
                onChange={() => settings.mutate({ storageMode: 'tmanage' })}
              />
            </div>

            <DriveOption
              view={status.data}
              busy={busy}
              onUseDrive={() => settings.mutate({ storageMode: 'google_drive' })}
              onConnect={() => connect.mutate()}
              onDisconnect={() => disconnect.mutate()}
              onChangeFolder={() => changeFolder.mutate()}
              onMyDrive={() => settings.mutate({ location: { kind: 'my_drive' } })}
            />
          </div>
        </section>
      )}
    </ControlCenterShell>
  );
}

interface DriveOptionProps {
  view: StorageStatusView;
  busy: boolean;
  onUseDrive: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onChangeFolder: () => void;
  onMyDrive: () => void;
}

function DriveOption({
  view,
  busy,
  onUseDrive,
  onConnect,
  onDisconnect,
  onChangeFolder,
  onMyDrive,
}: DriveOptionProps) {
  const t = useT();
  const drive = view.googleDrive;
  const connected = view.configured && drive.status === 'connected';

  return (
    <div className="tm-storage__option">
      <Checkbox
        className="tm-storage__choice"
        label={t('AdminStorageScreen.driveTitle')}
        hint={
          <>
            {t('AdminStorageScreen.driveBody')}{' '}
            <span className="tm-storage__path" dir="ltr">
              TManage/‹{t('AdminStorageScreen.pathProject')}›/‹
              {t('AdminStorageScreen.pathWorkItem')}›/
            </span>
          </>
        }
        checked={view.storageMode === 'google_drive'}
        disabled={busy || !connected || view.storageMode === 'google_drive'}
        onChange={onUseDrive}
      />

      {!view.configured ? (
        <InlineAlert tone="neutral" title={t('AdminStorageScreen.notConfiguredTitle')}>
          {t('AdminStorageScreen.notConfiguredBody')}
        </InlineAlert>
      ) : drive.status === 'not_connected' ? (
        <>
          <StateCapsule className="tm-storage__capsule">
            {t('AdminStorageScreen.notConnected')}
          </StateCapsule>
          <div className="tm-storage__actions">
            <Button tone="lime" size="feature" loading={busy} onClick={onConnect}>
              {t('AdminStorageScreen.connect')}
            </Button>
          </div>
          <p className="tm-storage__caption">{t('AdminStorageScreen.connectNote')}</p>
        </>
      ) : drive.status === 'error' ? (
        <>
          <InlineAlert tone="danger" title={t('AdminStorageScreen.errorTitle')}>
            {t('AdminStorageScreen.errorBody')}
          </InlineAlert>
          <div className="tm-storage__actions">
            <Button tone="lime" size="feature" loading={busy} onClick={onConnect}>
              {t('AdminStorageScreen.reconnect')}
            </Button>
            <Button tone="destructive" size="feature" disabled={busy} onClick={onDisconnect}>
              {t('AdminStorageScreen.disconnect')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <StateCapsule state="done" className="tm-storage__capsule">
            {t('AdminStorageScreen.connected')}
          </StateCapsule>
          <dl className="tm-storage__facts">
            {drive.accountEmail ? (
              <div className="tm-storage__fact">
                <dt>{t('AdminStorageScreen.account')}</dt>
                <dd dir="ltr">{drive.accountEmail}</dd>
              </div>
            ) : null}
            <div className="tm-storage__fact">
              <dt>{t('AdminStorageScreen.folder')}</dt>
              <dd dir="ltr">{drive.folderPath ?? 'TManage/'}</dd>
            </div>
            <div className="tm-storage__fact">
              <dt>{t('AdminStorageScreen.sharedDrive')}</dt>
              <dd>
                <Select
                  label={drive.sharedDriveName ?? t('AdminStorageScreen.myDrive')}
                  hint={t('AdminStorageScreen.sharedDriveHint')}
                  value={drive.sharedDriveName ? 'shared' : 'my_drive'}
                  disabled={busy}
                  onChange={(event) => {
                    if (event.target.value === 'my_drive') onMyDrive();
                    else if (event.target.value === 'other') onChangeFolder();
                  }}
                >
                  <option value="my_drive">{t('AdminStorageScreen.myDrive')}</option>
                  {drive.sharedDriveName ? (
                    <option value="shared">{drive.sharedDriveName}</option>
                  ) : null}
                  <option value="other" disabled={!view.pickerAvailable}>
                    {t('AdminStorageScreen.otherSharedDrive')}
                  </option>
                </Select>
              </dd>
            </div>
          </dl>
          <div className="tm-storage__actions">
            <Button
              tone="outline"
              size="feature"
              disabled={busy || !view.pickerAvailable}
              onClick={onChangeFolder}
            >
              {t('AdminStorageScreen.changeFolder')}
            </Button>
            <Button tone="destructive" size="feature" disabled={busy} onClick={onDisconnect}>
              {t('AdminStorageScreen.disconnect')}
            </Button>
          </div>
          <p className="tm-storage__caption">{t('AdminStorageScreen.existingFilesNote')}</p>
        </>
      )}
    </div>
  );
}
