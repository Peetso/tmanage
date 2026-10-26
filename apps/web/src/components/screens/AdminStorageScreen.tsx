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
  Switch,
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
import {
  completeOneDriveConnect,
  disconnectOneDrive,
  getOneDrivePickerSession,
  getOneDriveStatus,
  readOneDriveReturn,
  startOneDriveConnect,
  updateOneDriveSettings,
} from '../../lib/api/onedrive';
import type { OneDriveLocation, OneDriveStatusView } from '../../lib/api/onedrive';
import type { ApiClient } from '../../lib/api/client';
import { openDrivePicker } from '../../lib/google-picker';
import { openOneDrivePicker, reservePickerWindow } from '../../lib/onedrive-picker';
import { closeIfBlank, oneDriveStatusKey } from '../storage/OneDriveAttachPicker';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { isFirstTimeStorage } from '../../lib/storage-attach-state';
import { useOrganizationName } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';
import '../../styles/screens/storage.css';

/**
 * Owner decision 2026-10-26: company storage is Google Drive or OneDrive only, so the TManage
 * storage choice is not offered. The API still supports it; flip this to bring the card back.
 * Avatars, logos and system exports keep using TManage storage whatever is chosen here.
 */
export const SHOW_TMANAGE_STORAGE = false;

export interface AdminStorageScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Control > Storage** (Figma ADM-14 · Storage: not configured 353:1172, connected 353:1296,
 * error 353:1450; with OneDrive 395:5239). Where this company's files live: the company's Google
 * Drive or OneDrive, in `TManage/<Project>/<Work item>/` (TManage storage behind
 * {@link SHOW_TMANAGE_STORAGE}).
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

  const oneDriveKey = oneDriveStatusKey(organizationSlug);
  const status = useQuery({ queryKey, queryFn: () => getStorageStatus(api, organizationSlug) });
  const oneDriveStatus = useQuery({
    queryKey: oneDriveKey,
    queryFn: () => getOneDriveStatus(api, organizationSlug),
  });
  // The storage mode is one per company across providers: a change through one provider's
  // answer leaves the other's stale, so it is read again.
  const store = (view: StorageStatusView) => {
    queries.setQueryData(queryKey, view);
    void queries.invalidateQueries({ queryKey: oneDriveKey });
  };
  const storeOneDrive = (view: OneDriveStatusView) => {
    queries.setQueryData(oneDriveKey, view);
    void queries.invalidateQueries({ queryKey });
  };

  const complete = useMutation({
    mutationFn: (input: { code: string; state: string }) =>
      completeDriveConnect(api, organizationSlug, input),
    onSuccess: store,
  });

  const completeOneDrive = useMutation({
    mutationFn: (input: { code: string; state: string }) =>
      completeOneDriveConnect(api, organizationSlug, input),
    onSuccess: storeOneDrive,
  });

  // Google's or Microsoft's answer comes back in the fragment; handle it once, then remove it.
  useEffect(() => {
    if (handledReturn.current || typeof window === 'undefined') return;
    handledReturn.current = true;
    const drive = readDriveReturn(window.location.hash);
    const oneDrive = drive ? null : readOneDriveReturn(window.location.hash);
    const returned = drive ?? oneDrive;
    if (!returned) return;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    if (returned.kind === 'error') setReturnError(true);
    else if (drive) complete.mutate({ code: returned.code, state: returned.state });
    else completeOneDrive.mutate({ code: returned.code, state: returned.state });
  }, [complete, completeOneDrive]);

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
      // Without a project the API answers the owner only, and always with the Google picker.
      if (session.mode !== 'google') throw new Error('picker_unavailable');
      const [folder] = await openDrivePicker({
        accessToken: session.accessToken,
        apiKey: session.apiKey,
        appId: session.appId,
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

  const connectOneDrive = useMutation({
    mutationFn: (libraries: boolean) => startOneDriveConnect(api, organizationSlug, { libraries }),
    onSuccess: ({ url }) => window.location.assign(url),
  });

  const oneDriveSettings = useMutation({
    mutationFn: (input: { storageMode?: 'tmanage' | 'onedrive'; location?: OneDriveLocation }) =>
      updateOneDriveSettings(api, organizationSlug, input),
    onSuccess: storeOneDrive,
  });

  const disconnectMicrosoft = useMutation({
    mutationFn: () => disconnectOneDrive(api, organizationSlug),
    onSuccess: storeOneDrive,
  });

  // The popup is opened inside the click (see the button), so the browser does not block it.
  const changeOneDriveFolder = useMutation({
    mutationFn: async (popup: Window | null) => {
      const session = await getOneDrivePickerSession(api, organizationSlug);
      // Without a project the API answers the owner only, and always with the picker.
      if (session.mode !== 'onedrive' || !popup) throw new Error('picker_unavailable');
      const [folder] = await openOneDrivePicker({
        popup,
        session,
        mode: 'folder',
        locale,
        tokenFor: async (resource) => {
          const next = await getOneDrivePickerSession(api, organizationSlug, { resource });
          if (next.mode !== 'onedrive') throw new Error('picker_unavailable');
          return next.accessToken;
        },
      });
      if (!folder) return null;
      return updateOneDriveSettings(api, organizationSlug, {
        location: { kind: 'folder', driveId: folder.driveId, itemId: folder.itemId },
      });
    },
    onSuccess: (view) => {
      if (view) storeOneDrive(view);
    },
    onSettled: (_view, _error, popup) => closeIfBlank(popup),
  });

  const oneDriveMutations = [
    completeOneDrive,
    connectOneDrive,
    oneDriveSettings,
    disconnectMicrosoft,
    changeOneDriveFolder,
  ];
  const failed =
    returnError ||
    complete.isError ||
    connect.isError ||
    settings.isError ||
    disconnect.isError ||
    changeFolder.isError ||
    oneDriveMutations.some((mutation) => mutation.isError);
  const busy =
    complete.isPending ||
    connect.isPending ||
    settings.isPending ||
    disconnect.isPending ||
    changeFolder.isPending ||
    oneDriveMutations.some((mutation) => mutation.isPending);
  const oneDriveView = oneDriveStatus.data;
  // Figma 419:23593 / 419:23699: before Google Drive or OneDrive has ever been connected, the
  // screen is the first-time choice between the two.
  const firstTime = isFirstTimeStorage(status.data, oneDriveView);

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="storage"
      crumbs={[t('AdminStorageScreen.crumb')]}
      title={t(firstTime ? 'StorageFirstTime.title' : 'AdminStorageScreen.title')}
      description={firstTime ? t('StorageFirstTime.intro') : undefined}
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
        <section
          className={firstTime ? 'tm-storage tm-storage--first-time' : 'tm-storage'}
          aria-labelledby="tm-storage-heading"
        >
          <h2 id="tm-storage-heading" className="tm-visually-hidden">
            {t('AdminStorageScreen.title')}
          </h2>
          {firstTime ? null : (
            <p className="tm-storage__intro">
              {t('AdminStorageScreen.introNamed').replace('{name}', organizationName)}
            </p>
          )}

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
            {SHOW_TMANAGE_STORAGE ? (
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
            ) : null}

            <DriveOption
              view={status.data}
              oneDrive={oneDriveView}
              firstTime={firstTime}
              busy={busy}
              onUseDrive={() => settings.mutate({ storageMode: 'google_drive' })}
              onConnect={() => connect.mutate()}
              onDisconnect={() => disconnect.mutate()}
              onChangeFolder={() => changeFolder.mutate()}
              onMyDrive={() => settings.mutate({ location: { kind: 'my_drive' } })}
            />

            {oneDriveView ? (
              <OneDriveOption
                view={oneDriveView}
                firstTime={firstTime}
                busy={busy}
                onUse={() => oneDriveSettings.mutate({ storageMode: 'onedrive' })}
                onConnect={(libraries) => connectOneDrive.mutate(libraries)}
                onDisconnect={() => disconnectMicrosoft.mutate()}
                onChangeFolder={() => changeOneDriveFolder.mutate(reservePickerWindow())}
              />
            ) : null}
          </div>

          {firstTime ? (
            <p className="tm-storage__note">
              {t('StorageFirstTime.note').replace('{name}', organizationName)}
            </p>
          ) : null}
        </section>
      )}
    </ControlCenterShell>
  );
}

interface DriveOptionProps {
  view: StorageStatusView;
  /** 0236. While OneDrive is connected Google Drive is not offered a connect; see 395:5385. */
  oneDrive: OneDriveStatusView | undefined;
  /** 419:23660: the first-time card, its state and ink button indented under the choice. */
  firstTime: boolean;
  busy: boolean;
  onUseDrive: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onChangeFolder: () => void;
  onMyDrive: () => void;
}

function DriveOption({
  view,
  oneDrive,
  firstTime,
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
  const oneDriveConnected = oneDrive?.oneDrive.status === 'connected';
  // One lime call to action on the screen: OneDrive's while it offers a connect (395:5240).
  const oneDriveOffersConnect =
    oneDrive?.configured === true && oneDrive.oneDrive.status === 'not_connected';

  return (
    <div className="tm-storage__option">
      <Checkbox
        className="tm-storage__choice"
        label={t('AdminStorageScreen.driveTitle')}
        hint={t('AdminStorageScreen.driveLine')}
        checked={view.storageMode === 'google_drive'}
        disabled={busy || !connected || view.storageMode === 'google_drive'}
        onChange={onUseDrive}
      />

      {!view.configured ? (
        <InlineAlert tone="neutral" title={t('AdminStorageScreen.notConfiguredTitle')}>
          {t('AdminStorageScreen.notConfiguredBody')}
        </InlineAlert>
      ) : drive.status === 'not_connected' && firstTime ? (
        <div className="tm-storage__details">
          <StateCapsule className="tm-storage__capsule">
            {t('AdminStorageScreen.notConnected')}
          </StateCapsule>
          <div className="tm-storage__actions">
            <Button tone="ink" size="feature" loading={busy} onClick={onConnect}>
              {t('AdminStorageScreen.connect')}
            </Button>
          </div>
        </div>
      ) : drive.status === 'not_connected' ? (
        <>
          <StateCapsule className="tm-storage__capsule">
            {t('AdminStorageScreen.notConnected')}
          </StateCapsule>
          {oneDriveConnected ? null : (
            <div className="tm-storage__actions">
              <Button
                tone={oneDriveOffersConnect ? 'outline' : 'lime'}
                size="feature"
                loading={busy}
                onClick={onConnect}
              >
                {t('AdminStorageScreen.connect')}
              </Button>
            </div>
          )}
          {oneDriveOffersConnect || oneDriveConnected ? null : (
            <p className="tm-storage__caption">{t('AdminStorageScreen.connectNote')}</p>
          )}
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

interface OneDriveOptionProps {
  view: OneDriveStatusView;
  /** 419:23670: the first-time card, its state, ink button and note indented under the choice. */
  firstTime: boolean;
  busy: boolean;
  onUse: () => void;
  onConnect: (libraries: boolean) => void;
  onDisconnect: () => void;
  onChangeFolder: () => void;
}

/**
 * The OneDrive card (Figma 395:5240 not connected, 395:5385 connected, 395:5545 not configured;
 * Arabic 395:5869 / 395:6010 / 395:6168). Turning on SharePoint libraries is a second Microsoft
 * consent (incremental), so the switch reconnects; a library is then chosen with Change folder.
 */
function OneDriveOption({
  view,
  firstTime,
  busy,
  onUse,
  onConnect,
  onDisconnect,
  onChangeFolder,
}: OneDriveOptionProps) {
  const t = useT();
  const drive = view.oneDrive;
  const connected = view.configured && drive.status === 'connected';
  const library = drive.librariesEnabled && drive.driveName ? drive.driveName : null;
  const folder = (drive.folderPath ?? 'TManage/').replace(/\/+$/, '');

  return (
    <div className="tm-storage__option">
      <Checkbox
        className="tm-storage__choice"
        label="OneDrive"
        hint={t('OneDriveStorage.body')}
        checked={view.storageMode === 'onedrive'}
        disabled={busy || !connected || view.storageMode === 'onedrive'}
        onChange={onUse}
      />

      {!view.configured ? (
        <>
          <StateCapsule className="tm-storage__capsule">
            {t('OneDriveStorage.notAvailable')}
          </StateCapsule>
          <InlineAlert tone="warning">{t('OneDriveStorage.notConfiguredBody')}</InlineAlert>
          <div className="tm-storage__actions">
            <Button tone="lime" size="feature" disabled>
              {t('OneDriveStorage.connect')}
            </Button>
          </div>
        </>
      ) : drive.status === 'not_connected' && firstTime ? (
        <div className="tm-storage__details">
          <StateCapsule className="tm-storage__capsule">
            {t('OneDriveStorage.notConnected')}
          </StateCapsule>
          <div className="tm-storage__actions">
            <Button tone="ink" size="feature" loading={busy} onClick={() => onConnect(false)}>
              {t('OneDriveStorage.connect')}
            </Button>
          </div>
          <p className="tm-storage__caption">{t('OneDriveStorage.connectNote')}</p>
        </div>
      ) : drive.status === 'not_connected' ? (
        <>
          <StateCapsule className="tm-storage__capsule">
            {t('OneDriveStorage.notConnected')}
          </StateCapsule>
          <div className="tm-storage__actions">
            <Button tone="lime" size="feature" loading={busy} onClick={() => onConnect(false)}>
              {t('OneDriveStorage.connect')}
            </Button>
          </div>
          <p className="tm-storage__caption">{t('OneDriveStorage.connectNote')}</p>
        </>
      ) : drive.status === 'error' ? (
        <>
          <InlineAlert tone="danger" title={t('OneDriveStorage.errorTitle')}>
            {t('OneDriveStorage.errorBody')}
          </InlineAlert>
          <div className="tm-storage__actions">
            <Button
              tone="lime"
              size="feature"
              loading={busy}
              onClick={() => onConnect(drive.librariesEnabled)}
            >
              {t('OneDriveStorage.reconnect')}
            </Button>
            <Button tone="destructive" size="feature" disabled={busy} onClick={onDisconnect}>
              {t('OneDriveStorage.disconnect')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <StateCapsule state="done" className="tm-storage__capsule">
            {t('OneDriveStorage.connected')}
          </StateCapsule>
          <dl className="tm-storage__facts">
            {drive.accountEmail ? (
              <div className="tm-storage__fact">
                <dt>{t('OneDriveStorage.account')}</dt>
                <dd dir="ltr">{drive.accountEmail}</dd>
              </div>
            ) : null}
            <div className="tm-storage__fact">
              <dt>{t('OneDriveStorage.rootFolder')}</dt>
              <dd>
                {t('OneDriveStorage.rootPath')
                  .replace('{root}', library ?? t('OneDriveStorage.myFiles'))
                  .replace('{folder}', folder)}
              </dd>
            </div>
            <div className="tm-storage__fact">
              <dt>{t('OneDriveStorage.library')}</dt>
              <dd>{library ?? t('OneDriveStorage.notUsed')}</dd>
            </div>
          </dl>
          <hr className="tm-storage__rule" />
          <Switch
            className="tm-storage__switch"
            label={t('OneDriveStorage.useLibrary')}
            hint={t('OneDriveStorage.useLibraryHint')}
            checked={drive.librariesEnabled}
            disabled={busy || drive.librariesEnabled}
            onChange={() => onConnect(true)}
          />
          <div className="tm-storage__actions">
            <Button
              tone="outline"
              size="feature"
              disabled={busy || !view.pickerAvailable}
              onClick={onChangeFolder}
            >
              {t('OneDriveStorage.changeFolder')}
            </Button>
            <Button tone="destructive" size="feature" disabled={busy} onClick={onDisconnect}>
              {t('OneDriveStorage.disconnect')}
            </Button>
          </div>
          <p className="tm-storage__caption">{t('OneDriveStorage.existingFilesNote')}</p>
        </>
      )}
    </div>
  );
}
