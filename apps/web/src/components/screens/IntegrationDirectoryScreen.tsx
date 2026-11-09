'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import '../../styles/screens/automations.css';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  connectIntegrationApp,
  listIntegrationApps,
  type IntegrationAppView,
} from '../../lib/api/integration-directory';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { getStorageStatus } from '../../lib/api/google-drive';
import { getOneDriveStatus } from '../../lib/api/onedrive';
import { oneDriveStatusKey } from '../storage/OneDriveAttachPicker';
import { appState } from './integration-directory-view';
import {
  localizedDescribeApp,
  localizedDescribeAppLine,
  localizedDirectoryTitle,
  localizedRelativeAgo,
} from './integration-directory-i18n';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface IntegrationDirectoryScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Automations app directory (module 17, x165).**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Automations ("app directory"). This screen reads the
 * static integration catalog merged with the organization's connections (`GET …/automations/apps`,
 * `org.manage`) and records a connection against a catalog app (`POST …/automations/apps/:appId/
 * connections`).
 *
 * ## What it does, and what it cannot
 *
 * - **No secrets.** The connect form collects a label and an optional non-secret setting only. Live
 *   OAuth / credential exchange is out of scope (Needs-Peter); the API rejects secret-shaped config
 *   keys, and this form never asks for one.
 * - **A connection is recorded, never edited or removed here.** The API grants create and read only
 *   this slice, so there is no edit or disconnect control.
 */
export function IntegrationDirectoryScreen({
  organizationSlug,
  organizationName,
  client,
}: IntegrationDirectoryScreenProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();
  const tr = useTOr();
  const locale = useActiveLocale();

  const apps = useQuery({
    queryKey: ['integration-apps', organizationSlug],
    queryFn: () => listIntegrationApps(api, organizationSlug),
  });
  // C22: Google Drive and OneDrive are company storage (Control > Storage); the directory lists
  // them too, with their connection state, so an owner finds them where the other tools are.
  // Same keys as the Storage screen, so the two share one request.
  const drive = useQuery({
    queryKey: ['storage-status', organizationSlug],
    queryFn: () => getStorageStatus(api, organizationSlug),
    staleTime: 60_000,
    retry: false,
  });
  const oneDrive = useQuery({
    queryKey: oneDriveStatusKey(organizationSlug),
    queryFn: () => getOneDriveStatus(api, organizationSlug),
    staleTime: 60_000,
    retry: false,
  });
  const storageRows: readonly StorageRow[] = [
    {
      id: 'google-drive',
      name: 'Google Drive',
      status: drive.data?.googleDrive.status,
      account: drive.data?.googleDrive.accountEmail ?? null,
    },
    {
      id: 'onedrive',
      name: 'OneDrive',
      status: oneDrive.data?.oneDrive.status,
      account: oneDrive.data?.oneDrive.accountEmail ?? null,
    },
  ];

  const [activeAppId, setActiveAppId] = useState('');
  const [label, setLabel] = useState('');
  const [settingKey, setSettingKey] = useState('');
  const [settingValue, setSettingValue] = useState('');
  const [connected, setConnected] = useState<{ appId: string; label: string } | null>(null);
  const [filter, setFilter] = useState<DirectoryFilter>('all');

  const rows = apps.data ?? [];
  const activeApp = rows.find((app) => app.id === activeAppId) ?? null;
  const connectedApps = rows.filter((app) => app.connections.length > 0);
  const availableApps = rows.filter((app) => app.connections.length === 0);

  const connect = useMutation({
    mutationFn: (app: IntegrationAppView) => {
      const config: Record<string, string> = {};
      if (settingKey.trim() !== '' && settingValue.trim() !== '') {
        config[settingKey.trim()] = settingValue.trim();
      }
      return connectIntegrationApp(api, organizationSlug, app.id, {
        label: label.trim(),
        config,
      });
    },
    onSuccess: async (connection) => {
      setConnected({ appId: connection.appId, label: connection.label });
      setLabel('');
      setSettingKey('');
      setSettingValue('');
      await queryClient.invalidateQueries({ queryKey: ['integration-apps', organizationSlug] });
    },
  });

  const canConnect = activeApp !== null && label.trim() !== '' && !connect.isPending;
  const loaded = !apps.isPending && !apps.isError;

  const title = loaded
    ? localizedDirectoryTitle(rows, tr, locale)
    : t('IntegrationDirectoryScreen.titleFallback');

  return (
    <SettingsShell
      section="integrations"
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow={t('IntegrationDirectoryScreen.eyebrow')}
      title={title}
      description={t('IntegrationDirectoryScreen.description')}
      actions={
        <>
          <Link href={`/${organizationSlug}/admin/audit`} className="tm-aut-btn">
            {t('IntegrationDirectoryScreen.auditAccess')}
          </Link>
          <a href="#tm-connect" className="tm-aut-btn tm-aut-btn--ink">
            {t('IntegrationDirectoryScreen.connectATool')}
          </a>
        </>
      }
    >
      <div className="tm-aut">
        {loaded ? (
          <fieldset className="tm-aut-filters tm-aut-filters--end">
            <legend className="tm-visually-hidden">{t('IntegrationDirectoryScreen.show')}</legend>
            {(
              [
                ['all', `${t('IntegrationDirectoryScreen.filterAll')} · ${rows.length}`],
                [
                  'connected',
                  `${t('IntegrationDirectoryScreen.filterConnected')} · ${connectedApps.length}`,
                ],
                [
                  'available',
                  `${t('IntegrationDirectoryScreen.filterAvailable')} · ${availableApps.length}`,
                ],
              ] as const
            ).map(([value, text]) => (
              <button
                key={value}
                type="button"
                className="tm-aut-filter"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {text}
              </button>
            ))}
          </fieldset>
        ) : null}

        {apps.isError ? (
          <InlineAlert tone="danger" title={t('IntegrationDirectoryScreen.loadErrorTitle')} live>
            {describeError(apps.error)}
          </InlineAlert>
        ) : null}

        {loaded && filter !== 'available' && connectedApps.length > 0 ? (
          <section aria-labelledby="tm-apps-connected-heading" className="tm-aut-col">
            <h2 id="tm-apps-connected-heading" className="tm-visually-hidden">
              {t('IntegrationDirectoryScreen.connected')}
            </h2>
            <ul className="tm-aut-tools" aria-label={t('IntegrationDirectoryScreen.connectedApps')}>
              {connectedApps.map((app) => {
                const live = appState(app) === 'live';
                return (
                  <li key={app.id} className="tm-aut-tool">
                    <div className="tm-aut-tool__head">
                      <span className="tm-aut-glyph" aria-hidden="true">
                        {glyphFor(app.category)}
                      </span>
                      <span
                        className={`tm-aut-state ${live ? 'tm-aut-state--live' : 'tm-aut-state--warning'}`}
                      >
                        {live
                          ? t('IntegrationDirectoryScreen.stateConnected')
                          : t('IntegrationDirectoryScreen.statePending')}
                      </span>
                    </div>
                    <h3 className="tm-aut-tool__name">{app.name}</h3>
                    <p className="tm-aut-tool__body">{localizedDescribeApp(app, tr, locale)}</p>
                    <ul
                      className="tm-aut-tool__foot"
                      aria-label={`${app.name} ${t('IntegrationDirectoryScreen.connectionsSuffix')}`}
                    >
                      {app.connections.map((connection) => (
                        <li key={connection.id} className="tm-aut-tool__conn">
                          <span className="tm-aut-mono">{connection.label}</span>
                          <span className="tm-aut-mono">
                            <span className="tm-visually-hidden">
                              {connection.status === 'connected'
                                ? t('IntegrationDirectoryScreen.stateConnected')
                                : t('IntegrationDirectoryScreen.statePending')}
                              {t('IntegrationDirectoryScreen.commaAdded')}
                            </span>
                            {localizedRelativeAgo(connection.createdAt, tr, locale)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        <div className="tm-aut-split">
          <section className="tm-aut-col" aria-labelledby="tm-apps-heading">
            <div className="tm-aut-section-head">
              <h2 id="tm-apps-heading" className="tm-aut-section-head__title">
                {filter === 'connected'
                  ? t('IntegrationDirectoryScreen.connected')
                  : t('IntegrationDirectoryScreen.available')}
              </h2>
              <span className="tm-aut-section-head__meta">
                {t('IntegrationDirectoryScreen.sectionMeta')}
              </span>
            </div>

            {apps.isPending ? (
              <LoadingRegion label={t('IntegrationDirectoryScreen.loading')}>
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}

            {/* The storage, webhook and AI rows need no catalog, so they show at once (C22). */}
            <ul
              className="tm-aut-list"
              aria-label={t('IntegrationDirectoryScreen.appsInDirectory')}
            >
              {(filter === 'connected' ? connectedApps : availableApps).map((app) => (
                <li key={app.id}>
                  <span className="tm-aut-glyph tm-aut-glyph--small" aria-hidden="true">
                    {glyphFor(app.category)}
                  </span>
                  <div className="tm-aut-list__main">
                    <h3 className="tm-aut-rowtitle">{app.name}</h3>
                    <span className="tm-aut-rowsub">
                      {localizedDescribeAppLine(app, tr, locale)}
                      {app.connections.length > 0
                        ? ` · ${app.connections.length} ${
                            app.connections.length === 1
                              ? t('IntegrationDirectoryScreen.connectionSingular')
                              : t('IntegrationDirectoryScreen.connectionPlural')
                          }`
                        : ''}
                    </span>
                  </div>
                  <div className="tm-aut-list__end">
                    <a
                      href="#tm-connect"
                      className="tm-aut-btn"
                      aria-label={`${t('IntegrationDirectoryScreen.connectVerb')} ${app.name}`}
                      onClick={() => setActiveAppId(app.id)}
                    >
                      {t('IntegrationDirectoryScreen.connect')}
                    </a>
                  </div>
                </li>
              ))}
              {storageRows
                .filter((row) =>
                  filter === 'all'
                    ? true
                    : filter === 'connected'
                      ? row.status === 'connected'
                      : row.status !== 'connected',
                )
                .map((row) => (
                  <li key={row.id}>
                    <span className="tm-aut-glyph tm-aut-glyph--small" aria-hidden="true">
                      {glyphFor('storage')}
                    </span>
                    <div className="tm-aut-list__main">
                      <h3 className="tm-aut-rowtitle">{row.name}</h3>
                      <span className="tm-aut-rowsub">{storageLine(row, tr)}</span>
                    </div>
                    <div className="tm-aut-list__end">
                      <Link href={`/${organizationSlug}/admin/storage`} className="tm-aut-btn">
                        {row.status === 'connected'
                          ? t('IntegrationDirectoryScreen.manage')
                          : t('IntegrationDirectoryScreen.setUp')}
                      </Link>
                    </div>
                  </li>
                ))}
              <li>
                <span className="tm-aut-glyph tm-aut-glyph--small" aria-hidden="true">
                  {'{ }'}
                </span>
                <div className="tm-aut-list__main">
                  <h3 className="tm-aut-rowtitle">{t('IntegrationDirectoryScreen.webhooks')}</h3>
                  <span className="tm-aut-rowsub">
                    {t('IntegrationDirectoryScreen.webhooksSub')}
                  </span>
                </div>
                <div className="tm-aut-list__end">
                  <Link
                    href={`/${organizationSlug}/admin/automations/webhooks`}
                    className="tm-aut-btn"
                  >
                    {t('IntegrationDirectoryScreen.manage')}
                  </Link>
                </div>
              </li>
              <li>
                <span className="tm-aut-glyph tm-aut-glyph--small" aria-hidden="true">
                  ✦
                </span>
                <div className="tm-aut-list__main">
                  <h3 className="tm-aut-rowtitle">{t('IntegrationDirectoryScreen.aiAssistant')}</h3>
                  <span className="tm-aut-rowsub">
                    {t('IntegrationDirectoryScreen.aiAssistantSub')}
                  </span>
                </div>
                <div className="tm-aut-list__end">
                  <Link href={`/${organizationSlug}/settings/ai-assistant`} className="tm-aut-btn">
                    {t('IntegrationDirectoryScreen.setUp')}
                  </Link>
                </div>
              </li>
            </ul>
          </section>

          <section
            id="tm-connect"
            className="tm-aut-card tm-card--ink"
            aria-labelledby="tm-connect-heading"
          >
            <p className="tm-aut-eyebrow">{t('IntegrationDirectoryScreen.ruleEyebrow')}</p>
            <h2 id="tm-connect-heading" className="tm-aut-card__title">
              {t('IntegrationDirectoryScreen.ruleTitle')}
            </h2>
            <ul className="tm-aut-facts">
              <li>{t('IntegrationDirectoryScreen.fact1')}</li>
              <li>{t('IntegrationDirectoryScreen.fact2')}</li>
              <li>{t('IntegrationDirectoryScreen.fact3')}</li>
            </ul>

            {connected ? (
              <InlineAlert
                tone="success"
                title={t('IntegrationDirectoryScreen.connectionRecorded')}
                live
              >
                &ldquo;{connected.label}&rdquo; {t('IntegrationDirectoryScreen.wasConnected')}
              </InlineAlert>
            ) : null}

            {rows.length > 0 ? (
              <form
                className="tm-stack"
                noValidate
                onSubmit={(event: FormEvent<HTMLFormElement>) => {
                  event.preventDefault();
                  if (canConnect && activeApp) connect.mutate(activeApp);
                }}
              >
                <div className="tm-field">
                  <label className="tm-field__label" htmlFor="tm-app-select">
                    {t('IntegrationDirectoryScreen.appLabel')}
                  </label>
                  <select
                    id="tm-app-select"
                    className="tm-field__control"
                    value={activeAppId}
                    onChange={(event) => setActiveAppId(event.target.value)}
                  >
                    <option value="">{t('IntegrationDirectoryScreen.chooseAnApp')}</option>
                    {rows.map((app) => (
                      <option key={app.id} value={app.id}>
                        {app.name}
                      </option>
                    ))}
                  </select>
                </div>

                <Field
                  label={t('IntegrationDirectoryScreen.connectionLabel')}
                  name="label"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  hint={t('IntegrationDirectoryScreen.connectionLabelHint')}
                  required
                />

                <fieldset className="tm-aut-pair tm-fieldset">
                  <legend className="tm-field__label">
                    {t('IntegrationDirectoryScreen.optionalSetting')}
                  </legend>
                  <Field
                    label={t('IntegrationDirectoryScreen.settingName')}
                    name="setting-key"
                    value={settingKey}
                    onChange={(event) => setSettingKey(event.target.value)}
                    hint={t('IntegrationDirectoryScreen.settingNameHint')}
                  />
                  <Field
                    label={t('IntegrationDirectoryScreen.settingValue')}
                    name="setting-value"
                    value={settingValue}
                    onChange={(event) => setSettingValue(event.target.value)}
                  />
                </fieldset>

                {connect.isError ? (
                  <InlineAlert
                    tone="danger"
                    title={t('IntegrationDirectoryScreen.connectErrorTitle')}
                    live
                  >
                    {describeError(connect.error)}
                  </InlineAlert>
                ) : null}

                <div className="tm-aut-actions">
                  <Button
                    type="submit"
                    tone="lime"
                    size="accessible"
                    loading={connect.isPending}
                    loadingLabel={t('IntegrationDirectoryScreen.connecting')}
                    disabled={!canConnect}
                  >
                    {t('IntegrationDirectoryScreen.connectApp')}
                  </Button>
                </div>
              </form>
            ) : null}
          </section>
        </div>
      </div>
    </SettingsShell>
  );
}

type DirectoryFilter = 'all' | 'connected' | 'available';

/** A company-storage row (Google Drive, OneDrive); `status` is undefined until its read answers. */
interface StorageRow {
  readonly id: string;
  readonly name: string;
  readonly status: 'not_connected' | 'connected' | 'error' | undefined;
  readonly account: string | null;
}

/** A storage row's line: who it is connected as, that it needs reconnecting, or what it is for. */
function storageLine(row: StorageRow, tr: (key: string, english: string) => string): string {
  if (row.status === 'connected') {
    return row.account
      ? tr(
          'IntegrationDirectoryScreen.storageConnectedAs',
          'company storage · connected as {account}',
        ).replace('{account}', row.account)
      : tr('IntegrationDirectoryScreen.storageConnected', 'company storage · connected');
  }
  if (row.status === 'error') {
    return tr('IntegrationDirectoryScreen.storageError', 'company storage · needs reconnecting');
  }
  return tr('IntegrationDirectoryScreen.storageSub', 'keep the company’s files in your own drive');
}

/** The square glyph on each tool card, from the app's category (INT-01's ▦ ✉ ⇪ ◫). */
function glyphFor(category: string): string {
  const key = category.toLowerCase();
  if (key.includes('calendar')) return '▦';
  if (key.includes('mail')) return '✉';
  if (key.includes('storage') || key.includes('file')) return '⇪';
  if (key.includes('design')) return '◫';
  if (key.includes('chat') || key.includes('messag') || key.includes('communic')) return '◌';
  if (key.includes('time')) return '◔';
  if (key.includes('account') || key.includes('financ') || key.includes('billing')) return '◈';
  if (key.includes('dev') || key.includes('code')) return '‹›';
  return '◇';
}
