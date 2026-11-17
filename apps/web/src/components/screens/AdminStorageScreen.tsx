'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
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
  getOneDriveStatus,
  readOneDriveReturn,
  startOneDriveConnect,
  updateOneDriveSettings,
} from '../../lib/api/onedrive';
import type { OneDriveLocation, OneDriveStatusView } from '../../lib/api/onedrive';
import type { ApiClient } from '../../lib/api/client';
import { openDrivePicker } from '../../lib/google-picker';
import { oneDriveStatusKey } from '../storage/OneDriveAttachPicker';
import { OneDriveFolderDialog } from '../storage/OneDriveFolderDialog';
import { StorageRootNotice } from '../storage/StorageRootNotice';
import type { RootOwnerView } from '../../lib/api/storage-root';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { isFirstTimeStorage } from '../../lib/storage-attach-state';
import { useOrganizationName } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import '../../styles/screens/storage.css';
import './admin-label-spacing.css';
import { BrandLogo } from '../brand/BrandLogo';
import { isServicePaused } from '../../lib/api/service-paused';
import { ServicePausedNotice, pausedButtonProps } from './ServicePausedNotice';

/**
 * Owner decision 2026-10-31 (reverses 2026-10-26): TManage storage (1 GB per company) is
 * offered again next to Google Drive and OneDrive, and is the default until one is chosen.
 * Avatars, logos and system exports keep using TManage storage whatever is chosen here.
 */
export const SHOW_TMANAGE_STORAGE = true;

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
  const tOr = useTOr();
  const locale = useActiveLocale();
  const queryKey = ['storage-status', organizationSlug];
  const [returnError, setReturnError] = useState(false);
  // R36 F2. Change folder for OneDrive opens TManage's own folder browser (see the dialog).
  const [choosingOneDriveFolder, setChoosingOneDriveFolder] = useState(false);
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

  // R36 F2. The folder is browsed through the API with the connection's Graph token; File Picker
  // v8 needed a second Microsoft token that the connect never asked consent for, so it failed.
  const changeOneDriveFolder = useMutation({
    mutationFn: (folder: { driveId: string; itemId: string }) =>
      updateOneDriveSettings(api, organizationSlug, {
        location: { kind: 'folder', driveId: folder.driveId, itemId: folder.itemId },
      }),
    onSuccess: (view) => {
      storeOneDrive(view);
      setChoosingOneDriveFolder(false);
    },
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
  const drivePaused = [complete, connect, settings, changeFolder].some((mutation) =>
    isServicePaused(mutation.error),
  );
  const oneDrivePaused = oneDriveMutations.some((mutation) => isServicePaused(mutation.error));
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
              {tOr(
                'AdminStorageScreen.introBoth',
                'Choose where {name} keeps its files. You can connect Google Drive and OneDrive at the same time; new uploads go to the ticked one, and files already saved stay where they are.',
              ).replace('{name}', organizationName)}
            </p>
          )}
          {firstTime ? null : (
            // FIX6 Checkpoint A: task attachments go to TManage storage (item 2), whatever is ticked.
            <p className="tm-storage__caption">
              {tOr(
                'AdminStorageScreen.taskFilesNote',
                'Files added to tasks are kept on TManage storage, with the same safety checks as chat and Files.',
              )}
            </p>
          )}

          {drivePaused || oneDrivePaused ? (
            <>
              {drivePaused ? <ServicePausedNotice service="google_drive" /> : null}
              {oneDrivePaused ? <ServicePausedNotice service="onedrive" /> : null}
            </>
          ) : failed ? (
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
              paused={drivePaused}
              notice={
                status.data.googleDrive.rootOwner ? (
                  <StorageRootNotice
                    organizationSlug={organizationSlug}
                    client={api}
                    provider="google_drive"
                    rootOwner={status.data.googleDrive.rootOwner}
                    busy={busy}
                    onTakeOver={() => connect.mutate()}
                    onChanged={() => void queries.invalidateQueries({ queryKey })}
                  />
                ) : null
              }
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
                paused={oneDrivePaused}
                notice={
                  oneDriveView.oneDrive.rootOwner ? (
                    <StorageRootNotice
                      organizationSlug={organizationSlug}
                      client={api}
                      provider="onedrive"
                      rootOwner={oneDriveView.oneDrive.rootOwner}
                      busy={busy}
                      onTakeOver={() =>
                        connectOneDrive.mutate(oneDriveView.oneDrive.librariesEnabled)
                      }
                      onChanged={() => void queries.invalidateQueries({ queryKey: oneDriveKey })}
                    />
                  ) : null
                }
                onUse={() => oneDriveSettings.mutate({ storageMode: 'onedrive' })}
                onConnect={(libraries) => connectOneDrive.mutate(libraries)}
                onDisconnect={() => disconnectMicrosoft.mutate()}
                onChangeFolder={() => setChoosingOneDriveFolder(true)}
              />
            ) : null}
          </div>

          {choosingOneDriveFolder && oneDriveView ? (
            <OneDriveFolderDialog
              organizationSlug={organizationSlug}
              client={api}
              rootLabel={t('OneDriveStorage.myFiles')}
              busy={changeOneDriveFolder.isPending}
              onChoose={(folder) => changeOneDriveFolder.mutate(folder)}
              onClose={() => setChoosingOneDriveFolder(false)}
            />
          ) : null}

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
  /** 0236. Only for the one lime call to action; R36 F2: Drive can be connected beside OneDrive. */
  oneDrive: OneDriveStatusView | undefined;
  /** 419:23660: the first-time card, its state and ink button indented under the choice. */
  firstTime: boolean;
  busy: boolean;
  /** 51-17. Who owns the root, the steer and the hand-over (connected or error state). */
  notice: ReactNode;
  /** ADMINSVC3: Google Drive is switched off for the platform (Connect / Reconnect disabled). */
  paused: boolean;
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
  notice,
  paused,
  onUseDrive,
  onConnect,
  onDisconnect,
  onChangeFolder,
  onMyDrive,
}: DriveOptionProps) {
  const t = useT();
  const drive = view.googleDrive;
  const connected = view.configured && drive.status === 'connected';
  // One lime call to action on the screen: OneDrive's while it offers a connect (395:5240).
  const oneDriveOffersConnect =
    oneDrive?.configured === true && oneDrive.oneDrive.status === 'not_connected';

  return (
    <div className="tm-storage__option">
      <Checkbox
        className="tm-storage__choice"
        label={
          <>
            <BrandLogo brand="google-drive" size={24} className="tm-brand-logo--inline" />
            {t('AdminStorageScreen.driveTitle')}
          </>
        }
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
            <Button
              tone="ink"
              size="feature"
              loading={busy}
              onClick={onConnect}
              {...pausedButtonProps('google_drive', paused)}
            >
              {t('AdminStorageScreen.connect')}
            </Button>
          </div>
        </div>
      ) : drive.status === 'not_connected' ? (
        <>
          <StateCapsule className="tm-storage__capsule">
            {t('AdminStorageScreen.notConnected')}
          </StateCapsule>
          <div className="tm-storage__actions">
            <Button
              tone={oneDriveOffersConnect ? 'outline' : 'lime'}
              size="feature"
              loading={busy}
              onClick={onConnect}
              {...pausedButtonProps('google_drive', paused)}
            >
              {t('AdminStorageScreen.connect')}
            </Button>
          </div>
          {oneDriveOffersConnect ? null : (
            <p className="tm-storage__caption">{t('AdminStorageScreen.connectNote')}</p>
          )}
        </>
      ) : drive.status === 'error' ? (
        <>
          <InlineAlert tone="danger" title={t('AdminStorageScreen.errorTitle')}>
            {t('AdminStorageScreen.errorBody')}
          </InlineAlert>
          <div className="tm-storage__actions">
            <Button
              tone="lime"
              size="feature"
              loading={busy}
              onClick={onConnect}
              {...pausedButtonProps('google_drive', paused)}
            >
              {t('AdminStorageScreen.reconnect')}
            </Button>
            <Button tone="destructive" size="feature" disabled={busy} onClick={onDisconnect}>
              {t('AdminStorageScreen.disconnect')}
            </Button>
          </div>
          {notice}
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
            <RootOwnerFact rootOwner={drive.rootOwner} />
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
          {/* R36 F2. With both connected, "new files go to Drive" is true only while it is ticked. */}
          {view.storageMode === 'google_drive' ? (
            <p className="tm-storage__caption">{t('AdminStorageScreen.existingFilesNote')}</p>
          ) : null}
          {notice}
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
  /** 51-17. Who owns the root, the steer and the hand-over (connected or error state). */
  notice: ReactNode;
  /** ADMINSVC3: OneDrive is switched off for the platform (Connect / Reconnect disabled). */
  paused: boolean;
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
  notice,
  paused,
  onUse,
  onConnect,
  onDisconnect,
  onChangeFolder,
}: OneDriveOptionProps) {
  const t = useT();
  const drive = view.oneDrive;
  const connected = view.configured && drive.status === 'connected';
  const library = drive.librariesEnabled && drive.driveName ? drive.driveName : null;
  // The API answers `<chosen place>/TManage/`; the place is shown as the root, the last part as the folder.
  const folder = (drive.folderPath ?? 'TManage/').replace(/\/+$/, '').split('/').pop() || 'TManage';
  const root = drive.driveName ?? t('OneDriveStorage.myFiles');

  return (
    <div className="tm-storage__option">
      <Checkbox
        className="tm-storage__choice"
        label={
          <>
            <BrandLogo brand="onedrive" size={24} className="tm-brand-logo--inline" />
            OneDrive
          </>
        }
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
            <Button
              tone="ink"
              size="feature"
              loading={busy}
              onClick={() => onConnect(false)}
              {...pausedButtonProps('onedrive', paused)}
            >
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
            <Button
              tone="lime"
              size="feature"
              loading={busy}
              onClick={() => onConnect(false)}
              {...pausedButtonProps('onedrive', paused)}
            >
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
              {...pausedButtonProps('onedrive', paused)}
            >
              {t('OneDriveStorage.reconnect')}
            </Button>
            <Button tone="destructive" size="feature" disabled={busy} onClick={onDisconnect}>
              {t('OneDriveStorage.disconnect')}
            </Button>
          </div>
          {notice}
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
                {t('OneDriveStorage.rootPath').replace('{root}', root).replace('{folder}', folder)}
              </dd>
            </div>
            <div className="tm-storage__fact">
              <dt>{t('OneDriveStorage.library')}</dt>
              <dd>{library ?? t('OneDriveStorage.notUsed')}</dd>
            </div>
            <RootOwnerFact rootOwner={drive.rootOwner} />
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
          {view.storageMode === 'onedrive' ? (
            <p className="tm-storage__caption">{t('OneDriveStorage.existingFilesNote')}</p>
          ) : null}
          {notice}
        </>
      )}
    </div>
  );
}

/** 51-17. The owner badge of a connected root: the company, or one person. */
function RootOwnerFact({ rootOwner }: { rootOwner: RootOwnerView | null }) {
  const tr = useTOr();
  if (!rootOwner || rootOwner.kind === 'unknown') return null;
  return (
    <div className="tm-storage__fact">
      <dt>{tr('StorageRoot.ownerLabel', 'Owned by')}</dt>
      <dd>
        {rootOwner.companyOwned
          ? tr('StorageRoot.ownerCompany', 'The company')
          : tr('StorageRoot.ownerPersonal', 'One person')}
      </dd>
    </div>
  );
}
