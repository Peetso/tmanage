'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, StateCapsule } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import { BrandLogo, BRAND_NAMES } from '../brand/BrandLogo';
import '../../styles/screens/automations.css';
import '../../styles/screens/integration-cards.css';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  connectIntegrationApp,
  listIntegrationApps,
  type IntegrationAppView,
} from '../../lib/api/integration-directory';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { activeIsEnglish } from '../../lib/i18n/compact-time';
import { getStorageStatus, startDriveConnect } from '../../lib/api/google-drive';
import { getOneDriveStatus, startOneDriveConnect } from '../../lib/api/onedrive';
import {
  getGoogleCalendarStatus,
  getMicrosoftCalendarStatus,
  startCalendarConnect,
} from '../../lib/api/calendar-connections';
import {
  completeFigmaConnect,
  getFigmaConnection,
  readFigmaReturn,
  startFigmaConnect,
} from '../../lib/api/figma';
import { startAppConnect } from '../../lib/api/app-connect';
import { listConnectors } from '../../lib/api/connectors';
import { AppConnectPanel, useAppConnectStatus } from './AppConnectPanel';
import { ConnectorDirectory } from './ConnectorDirectory';
import { FigmaConnectCard } from './FigmaConnectCard';
import { useOrganizationRole } from '../../lib/use-organization-names';
import { oneDriveStatusKey } from '../storage/OneDriveAttachPicker';
import { localizedRelativeAgo } from './integration-directory-i18n';
import { numberWord } from './integration-directory-view';
import {
  INTEGRATION_CARDS,
  connectedTitle,
  type IntegrationCard,
  type IntegrationCardId,
} from './integration-directory-cards';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { isServicePaused } from '../../lib/api/service-paused';
import { ServicePausedNotice, pausedButtonProps } from './ServicePausedNotice';

export interface IntegrationDirectoryScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
  /** Where "Connect" sends the browser (the provider's consent screen). Tests pass their own. */
  navigate?: (url: string) => void;
}

/** What a card can offer right now, reduced from its provider's status read. */
type CardStatus =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly broken: boolean }
  /** FIX5: the provider's app is not registered on this server; the card says so, nothing more. */
  | { readonly kind: 'not_set_up' }
  | { readonly kind: 'connected'; readonly account: string | null };

type DirectoryFilter = 'all' | 'connected' | 'available';

const KEY = 'IntegrationDirectoryScreen';

/**
 * **Control center · Integrations** (`/{org}/automations/apps`, feedback 2026-11-09 item 6).
 *
 * One card per app with its official mark and one action. Where TManage has a real sign-in flow
 * (Google Drive, OneDrive, Google Calendar, Outlook Calendar) "Connect" asks the API for the
 * provider's consent address and sends the browser there in the same click; the provider returns to
 * Connected apps, which finishes the connection. Apps connected another way (Figma's access token,
 * GitHub's or Jira's key) say "Set up" and open the page that does it. An app
 * with no flow yet says "Coming soon": no form pretends to connect it.
 *
 * The catalog's hand-recorded connections (a label and one non-secret setting, never a credential)
 * stay available under **Advanced**, closed by default.
 */
export function IntegrationDirectoryScreen({
  organizationSlug,
  organizationName,
  client,
  navigate = (url) => globalThis.location.assign(url),
}: IntegrationDirectoryScreenProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();
  const tr = useTOr();
  const locale = useActiveLocale();
  const [filter, setFilter] = useState<DirectoryFilter>('all');
  const queries = useQueryClient();
  // FIX4 item 6: GitHub and Jira connect with a key (owners and admins, like their routes).
  const role = useOrganizationRole(organizationSlug);
  const managesCompany =
    role.known &&
    (['owner', 'org_admin', 'admin'].includes(role.role ?? '') ||
      (role.capabilities ?? []).includes('org.manage'));
  // Figma without one-click sign-in on this server: the key form, opened from its card.
  const [figmaKeyOpen, setFigmaKeyOpen] = useState(false);
  const [figmaOutcome, setFigmaOutcome] = useState<'success' | 'failure' | null>(null);
  // FIX5 item 6c (B-N8): the app whose key panel is open, from its card (each app is listed once).
  const [keyApp, setKeyApp] = useState<'github' | 'jira' | null>(null);
  const openKeyPanel = (app: 'github' | 'jira') => {
    setKeyApp(app);
    requestAnimationFrame(() =>
      globalThis.document?.getElementById('tm-int-keys')?.scrollIntoView?.({ block: 'start' }),
    );
  };

  // Same query keys as the Storage screen, Connected apps and the Control Center badge.
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
  const googleCal = useQuery({
    queryKey: ['calendar-connection', organizationSlug, 'google'],
    queryFn: () => getGoogleCalendarStatus(api, organizationSlug),
    retry: false,
  });
  const microsoftCal = useQuery({
    queryKey: ['calendar-connection', organizationSlug, 'microsoft'],
    queryFn: () => getMicrosoftCalendarStatus(api, organizationSlug),
    retry: false,
  });
  const figma = useQuery({
    queryKey: ['figma-connection', organizationSlug],
    queryFn: () => getFigmaConnection(api, organizationSlug),
    retry: false,
  });
  // FIX5: GitHub connects in one click (owners and admins; members keep the old way).
  const github = useAppConnectStatus(api, organizationSlug, 'github', managesCompany);
  // FIX5 item 6c: the key apps' own state, for their cards (same query key as the key panel).
  const connectors = useQuery({
    queryKey: ['connectors', organizationSlug],
    queryFn: () => listConnectors(api, organizationSlug),
    enabled: managesCompany,
    retry: false,
  });
  const keyInstalled = (key: string) =>
    connectors.data?.some(
      (connector) =>
        connector.key === key &&
        (connector.state === 'installed' || connector.state === 'connected'),
    ) === true;

  // Starts the API refused because the provider's sign-in is not set up on this server.
  const [refused, setRefused] = useState<ReadonlySet<IntegrationCardId>>(() => new Set());

  const statusOf = (id: IntegrationCardId): CardStatus => {
    if (refused.has(id)) return { kind: 'unavailable' };
    switch (id) {
      case 'google-drive':
        return reduce(
          drive,
          drive.data && {
            configured: drive.data.configured,
            status: drive.data.googleDrive.status,
            account: drive.data.googleDrive.accountEmail,
          },
        );
      case 'onedrive':
        return reduce(
          oneDrive,
          oneDrive.data && {
            configured: oneDrive.data.configured,
            status: oneDrive.data.oneDrive.status,
            account: oneDrive.data.oneDrive.accountEmail,
          },
        );
      case 'google-calendar':
        return reduce(
          googleCal,
          googleCal.data && {
            configured: googleCal.data.configured,
            status: googleCal.data.google.status,
            account: googleCal.data.google.accountEmail,
          },
        );
      case 'outlook':
        return reduce(
          microsoftCal,
          microsoftCal.data && {
            configured: microsoftCal.data.configured,
            status: microsoftCal.data.microsoft.status,
            account: microsoftCal.data.microsoft.accountEmail,
          },
        );
      case 'figma':
        if (figma.isPending || figmaComplete.isPending) return { kind: 'loading' };
        return figma.data?.status === 'connected'
          ? { kind: 'connected', account: figma.data.handle }
          : { kind: 'ready', broken: figma.data?.status === 'error' };
      case 'jira':
        if (!managesCompany) return { kind: 'ready', broken: false };
        if (connectors.isPending) return { kind: 'loading' };
        return keyInstalled('jira')
          ? { kind: 'connected', account: null }
          : { kind: 'ready', broken: false };
      case 'github': {
        const read = github;
        if (!managesCompany) return { kind: 'ready', broken: false };
        if (keyInstalled('github')) return { kind: 'connected', account: null };
        if (read.isPending) return { kind: 'loading' };
        if (read.isError || !read.data?.setUp) return { kind: 'not_set_up' };
        return read.data.connected
          ? { kind: 'connected', account: read.data.account }
          : { kind: 'ready', broken: false };
      }
      default:
        return { kind: 'ready', broken: false };
    }
  };

  // FIX4 item 6: Figma's return after one-click Connect (`#figma=complete&code=…&state=…`).
  const figmaComplete = useMutation({
    mutationFn: (body: { readonly code: string; readonly state: string }) =>
      completeFigmaConnect(api, organizationSlug, body),
    onSuccess: (view) => {
      queries.setQueryData(['figma-connection', organizationSlug], view);
      setFigmaOutcome('success');
    },
    onError: () => setFigmaOutcome('failure'),
  });
  const figmaHandled = useRef(false);
  useEffect(() => {
    if (figmaHandled.current) return;
    const back = readFigmaReturn(globalThis.location?.hash ?? '');
    if (!back) return;
    figmaHandled.current = true;
    globalThis.history?.replaceState(null, '', globalThis.location.pathname);
    if (back.kind === 'complete') figmaComplete.mutate({ code: back.code, state: back.state });
    else setFigmaOutcome('failure');
  }, [figmaComplete]);

  const connect = useMutation({
    mutationFn: (id: IntegrationCardId): Promise<{ readonly url: string }> => {
      if (id === 'figma') return startFigmaConnect(api, organizationSlug);
      if (id === 'github') return startAppConnect(api, organizationSlug, id);
      // Storage started here comes back to Connected apps, which finishes the hand-over (R38);
      // the calendars always come back there.
      if (id === 'google-drive') {
        return startDriveConnect(api, organizationSlug, { returnTo: 'connected-apps' });
      }
      if (id === 'onedrive') {
        return startOneDriveConnect(api, organizationSlug, { returnTo: 'connected-apps' });
      }
      return startCalendarConnect(api, organizationSlug, id === 'outlook' ? 'microsoft' : 'google');
    },
    onSuccess: ({ url }) => navigate(url),
    onError: (error, id) => {
      if (error instanceof ApiRequestError && error.status === 409 && !isServicePaused(error)) {
        setRefused((current) => new Set(current).add(id));
      }
    },
  });

  const statuses = new Map(INTEGRATION_CARDS.map((card) => [card.id, statusOf(card.id)]));
  const isConnected = (card: IntegrationCard) => statuses.get(card.id)?.kind === 'connected';
  const connectedCount = INTEGRATION_CARDS.filter(isConnected).length;
  const shown = INTEGRATION_CARDS.filter((card) =>
    filter === 'all' ? true : filter === 'connected' ? isConnected(card) : !isConnected(card),
  );
  // PAUSED-FLAG: the services the status reads say the platform paused, before anyone presses
  // Connect, and the one a Connect was just refused for.
  const keyPaused = (key: string) =>
    connectors.data?.some((connector) => connector.key === key && connector.paused === true) ===
    true;
  const pausedFromStatus: Readonly<Record<IntegrationCardId, boolean>> = {
    'google-drive': drive.data?.paused === true,
    onedrive: oneDrive.data?.paused === true,
    'google-calendar': googleCal.data?.paused === true,
    outlook: microsoftCal.data?.paused === true,
    figma: figma.data?.paused === true,
    github: github.data?.paused === true,
    jira: keyPaused('jira'),
    zapier: false,
  };
  const isPaused = (id: IntegrationCardId) =>
    pausedFromStatus[id] || (isServicePaused(connect.error) && connect.variables === id);
  const pausedCards = INTEGRATION_CARDS.filter(
    (card) => card.flow !== 'soon' && !isConnected(card) && isPaused(card.id),
  );

  const failedCard = connect.isError
    ? INTEGRATION_CARDS.find((card) => card.id === connect.variables)
    : undefined;
  const failedName = failedCard ? BRAND_NAMES[failedCard.brand] : '';
  const notSetUp = connect.error instanceof ApiRequestError && connect.error.status === 409;
  const refusedPaused = isServicePaused(connect.error);

  const title = connectedTitle(connectedCount, tr, activeIsEnglish(locale), locale, numberWord);

  return (
    <SettingsShell
      section="integrations"
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow={t('IntegrationDirectoryScreen.eyebrow')}
      // FIX3 item 10: headed with its menu name; the connected count opens the lede.
      title={t('ControlCenterShell.integrations')}
      // FIX5 item 6c: not "One click" for every app; Jira asks for a key.
      description={`${title}. ${tr(
        `${KEY}.lede`,
        'Connect the apps your team already uses. Most take one click; Jira asks once for a key from the app. You can disconnect any time.',
      )}`}
      actions={
        <Link href={`/${organizationSlug}/admin/audit`} className="tm-aut-btn">
          {t('IntegrationDirectoryScreen.auditAccess')}
        </Link>
      }
    >
      <div className="tm-aut tm-int">
        <fieldset className="tm-aut-filters tm-aut-filters--end">
          <legend className="tm-visually-hidden">{t('IntegrationDirectoryScreen.show')}</legend>
          {(
            [
              ['all', `${t('IntegrationDirectoryScreen.filterAll')} · ${INTEGRATION_CARDS.length}`],
              [
                'connected',
                `${t('IntegrationDirectoryScreen.filterConnected')} · ${connectedCount}`,
              ],
              [
                'available',
                `${t('IntegrationDirectoryScreen.filterAvailable')} · ${INTEGRATION_CARDS.length - connectedCount}`,
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

        {figmaOutcome === 'success' ? (
          <InlineAlert tone="success" live>
            {t('ConnectApps.success').replace('{app}', 'Figma')}
          </InlineAlert>
        ) : figmaOutcome === 'failure' ? (
          <InlineAlert
            tone="danger"
            title={t('ConnectApps.failedTitle').replace('{app}', 'Figma')}
            live
          >
            {tr(
              `${KEY}.figmaFailed`,
              'Figma did not finish the sign-in, so nothing was changed. Press Connect to try again.',
            )}
          </InlineAlert>
        ) : null}

        {pausedCards.map((card) => (
          <ServicePausedNotice key={card.id} service={card.id} />
        ))}
        {failedCard && !refusedPaused ? (
          notSetUp ? (
            <InlineAlert
              tone="warning"
              title={tr(`${KEY}.notSetUpTitle`, '{app} is not available yet').replace(
                '{app}',
                failedName,
              )}
              live
            >
              {tr(
                `${KEY}.notSetUpBody`,
                'Its sign-in is not set up on this TManage server yet, so nothing was changed. Your TManage admin can finish it from Connected apps.',
              )}
            </InlineAlert>
          ) : (
            <InlineAlert
              tone="danger"
              title={t('ConnectApps.failedTitle').replace('{app}', failedName)}
              live
            >
              {describeError(connect.error)}
            </InlineAlert>
          )
        ) : null}

        <section aria-labelledby="tm-int-heading" className="tm-aut-col">
          <h2 id="tm-int-heading" className="tm-aut-section-head__title">
            {t('ConnectApps.heading')}
          </h2>
          <ul className="tm-int-cards" aria-label={t('ConnectApps.heading')}>
            {shown.map((card) => (
              <IntegrationCardItem
                key={card.id}
                // FIX5: members connect GitHub the older way, as before.
                card={
                  !managesCompany && card.advancedPath
                    ? { ...card, flow: 'page', path: card.advancedPath }
                    : card
                }
                status={statuses.get(card.id) ?? { kind: 'loading' }}
                organizationSlug={organizationSlug}
                connecting={connect.isPending && connect.variables === card.id}
                busy={connect.isPending}
                paused={isPaused(card.id)}
                figmaOneClick={figma.data?.oneClick === true}
                keyInstalled={card.keyConnector ? keyInstalled(card.keyConnector) : false}
                {...(managesCompany && card.keyConnector
                  ? { onKeyConnect: () => openKeyPanel(card.keyConnector!) }
                  : {})}
                onConnect={() => connect.mutate(card.id)}
                onFigmaKey={() => {
                  setFigmaKeyOpen(true);
                  requestAnimationFrame(() =>
                    globalThis.document
                      ?.getElementById('tm-figma-connect')
                      ?.scrollIntoView?.({ block: 'start' }),
                  );
                }}
              />
            ))}
          </ul>
        </section>

        <div id="tm-figma-connect">
          {figmaKeyOpen ? (
            <FigmaConnectCard
              api={api}
              organizationSlug={organizationSlug}
              startOpen
              returnTo="integrations"
            />
          ) : null}
        </div>

        {managesCompany ? (
          <AppConnectPanel
            api={api}
            organizationSlug={organizationSlug}
            onGithubKey={() => openKeyPanel('github')}
          />
        ) : null}

        {managesCompany && keyApp ? (
          <ConnectorDirectory
            key={keyApp}
            api={api}
            organizationSlug={organizationSlug}
            only={keyApp}
            onDone={() => setKeyApp(null)}
          />
        ) : null}

        <section className="tm-aut-col" aria-labelledby="tm-int-more">
          <h2 id="tm-int-more" className="tm-aut-section-head__title">
            {tr(`${KEY}.moreHeading`, 'More ways to connect')}
          </h2>
          <ul className="tm-aut-list">
            <li>
              <span className="tm-aut-glyph tm-aut-glyph--small" aria-hidden="true">
                {'{ }'}
              </span>
              <div className="tm-aut-list__main">
                <h3 className="tm-aut-rowtitle">{t('IntegrationDirectoryScreen.webhooks')}</h3>
                <span className="tm-aut-rowsub">{t('IntegrationDirectoryScreen.webhooksSub')}</span>
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

        <AdvancedRecords api={api} organizationSlug={organizationSlug} />
      </div>
    </SettingsShell>
  );
}

function reduce(
  read: { readonly isPending: boolean; readonly isError: boolean },
  view: { configured: boolean; status: string; account: string | null } | null | undefined,
): CardStatus {
  if (read.isPending) return { kind: 'loading' };
  if (read.isError || !view || !view.configured) return { kind: 'unavailable' };
  if (view.status === 'connected') return { kind: 'connected', account: view.account };
  return { kind: 'ready', broken: view.status === 'error' };
}

function IntegrationCardItem({
  card,
  status,
  organizationSlug,
  connecting,
  busy,
  paused = false,
  figmaOneClick = false,
  keyInstalled = false,
  onConnect,
  onFigmaKey,
  onKeyConnect,
}: {
  card: IntegrationCard;
  status: CardStatus;
  organizationSlug: string;
  connecting: boolean;
  busy: boolean;
  /** PAUSED-FLAG: the platform paused this service, so Connect is disabled and points at why. */
  paused?: boolean;
  /** FIX4 item 6: Figma's own sign-in is set up, so its card connects in one click. */
  figmaOneClick?: boolean;
  onConnect: () => void;
  /** FIX4 item 6: Figma without one-click sign-in opens the key form on this page. */
  onFigmaKey?: () => void;
  /** FIX5 item 6c: the app is connected with a pasted key (its Manage opens the key panel). */
  keyInstalled?: boolean;
  /** FIX5 item 6c: owners and admins open this app's key panel from its card. */
  onKeyConnect?: () => void;
}) {
  const t = useT();
  const tr = useTOr();
  const name = BRAND_NAMES[card.brand];
  const href = card.path ? `/${organizationSlug}${card.path}` : undefined;

  let state: ReactNode = null;
  let action: ReactNode = null;
  if (card.flow === 'soon') {
    state = <StateCapsule state="future">{tr(`${KEY}.comingSoon`, 'Coming soon')}</StateCapsule>;
  } else if (status.kind === 'connected') {
    state = (
      <StateCapsule state="done" className="tm-state-capsule--fit">
        {status.account ? (
          <>
            {t('ConnectApps.connectedAs')}{' '}
            <bdi dir="ltr" className="tm-state-capsule__value" title={status.account}>
              {status.account}
            </bdi>
          </>
        ) : (
          t('ConnectApps.connected')
        )}
      </StateCapsule>
    );
    action =
      card.id === 'figma' ? (
        <button
          type="button"
          className="tm-aut-btn"
          aria-label={tr(`${KEY}.manageLabel`, 'Manage {app}').replace('{app}', name)}
          onClick={onFigmaKey}
        >
          {t('IntegrationDirectoryScreen.manage')}
        </button>
      ) : onKeyConnect && (keyInstalled || card.flow === 'page') ? (
        <button
          type="button"
          className="tm-aut-btn"
          aria-label={tr(`${KEY}.manageLabel`, 'Manage {app}').replace('{app}', name)}
          onClick={onKeyConnect}
        >
          {t('IntegrationDirectoryScreen.manage')}
        </button>
      ) : href ? (
        <Link
          href={href}
          className="tm-aut-btn"
          aria-label={tr(`${KEY}.manageLabel`, 'Manage {app}').replace('{app}', name)}
        >
          {t('IntegrationDirectoryScreen.manage')}
        </Link>
      ) : null;
  } else if (card.id === 'figma' && !figmaOneClick && status.kind !== 'loading') {
    action = (
      <Button
        tone="lime"
        aria-label={t('ConnectApps.connectLabel').replace('{app}', name)}
        onClick={onFigmaKey}
        {...pausedButtonProps(card.id, paused)}
      >
        {t('ConnectApps.connect')}
      </Button>
    );
  } else if (card.flow === 'page' && onKeyConnect) {
    // FIX5 item 6c (B-N8): Jira's Connect opens its key panel here; it is not listed twice.
    action = (
      <Button
        tone="lime"
        aria-label={t('ConnectApps.connectLabel').replace('{app}', name)}
        onClick={onKeyConnect}
        {...pausedButtonProps(card.id, paused)}
      >
        {t('ConnectApps.connect')}
      </Button>
    );
  } else if (card.flow === 'page' && card.keyConnector) {
    // Only owners and admins connect a key app; a member is told so instead of a dead link.
    action = (
      <p className="tm-int-card__hint">
        {tr(`${KEY}.askAdmin`, 'An owner or admin connects this for the company.')}
      </p>
    );
  } else if (card.flow === 'page' && card.id !== 'figma') {
    action = href ? (
      <Link
        href={href}
        className="tm-aut-btn tm-aut-btn--ink"
        aria-label={tr(`${KEY}.connectLabel`, 'Connect {app}').replace('{app}', name)}
      >
        {/* FIX3 item 9 (live I2): every app card says Connect; the page it opens does the rest. */}
        {tr(`${KEY}.connect`, 'Connect')}
      </Link>
    ) : null;
  } else if (status.kind === 'not_set_up') {
    // FIX5: no technical fields. The older way stays one quiet link away.
    state = (
      <StateCapsule state="waiting">{tr('AppConnect.notSetUp', 'Not set up yet')}</StateCapsule>
    );
    action = onKeyConnect ? (
      <button type="button" className="tm-aut-btn" onClick={onKeyConnect}>
        {tr('AppConnect.otherWay', 'Connect another way')}
      </button>
    ) : card.advancedPath ? (
      <Link href={`/${organizationSlug}${card.advancedPath}`} className="tm-aut-btn">
        {tr('AppConnect.otherWay', 'Connect another way')}
      </Link>
    ) : null;
  } else if (status.kind === 'unavailable') {
    state = <StateCapsule state="waiting">{t('ConnectApps.notAvailable')}</StateCapsule>;
    action = (
      <p className="tm-int-card__hint">
        {tr(
          `${KEY}.notSetUpHint`,
          'Its sign-in is not set up on this server yet. Your TManage admin can finish it.',
        )}
      </p>
    );
  } else if (status.kind === 'ready') {
    action = (
      <>
        {status.broken ? (
          <p className="tm-int-card__hint">{t('ConnectApps.needsReconnect')}</p>
        ) : null}
        <Button
          tone="lime"
          disabled={busy && !connecting}
          loading={connecting}
          loadingLabel={t('ConnectApps.connecting')}
          aria-label={t('ConnectApps.connectLabel').replace('{app}', name)}
          onClick={onConnect}
          {...pausedButtonProps(card.id, paused)}
        >
          {t('ConnectApps.connect')}
        </Button>
      </>
    );
  }

  return (
    <li className="tm-int-card" data-app={card.id} aria-busy={status.kind === 'loading'}>
      <div className="tm-int-card__head">
        <BrandLogo brand={card.brand} size={46} />
        {state}
      </div>
      <h3 className="tm-int-card__name">
        <bdi dir="ltr">{name}</bdi>
      </h3>
      <p className="tm-int-card__what">{tr(card.whatKey, card.what)}</p>
      <p className="tm-int-card__scope">
        {card.scopeKey && card.scopeText
          ? tr(card.scopeKey, card.scopeText)
          : card.scope === 'personal'
            ? tr(`${KEY}.scopePersonal`, 'Just for you: your own calendar')
            : tr(`${KEY}.scopeCompany`, 'For the whole company')}
      </p>
      {action ? <div className="tm-int-card__foot">{action}</div> : null}
    </li>
  );
}

/**
 * **Advanced** — the catalog's hand-recorded connections (x165): a label and at most one non-secret
 * setting against a catalog app. No credential is asked for or stored; the API rejects
 * secret-shaped keys. Closed by default: an owner connecting an app never needs it.
 */
function AdvancedRecords({ api, organizationSlug }: { api: ApiClient; organizationSlug: string }) {
  const describeError = useDescribeApiError();
  const queryClient = useQueryClient();
  const t = useT();
  const tr = useTOr();
  const locale = useActiveLocale();
  const [open, setOpen] = useState(false);
  const [activeAppId, setActiveAppId] = useState('');
  const [label, setLabel] = useState('');
  const [settingKey, setSettingKey] = useState('');
  const [settingValue, setSettingValue] = useState('');
  const [recorded, setRecorded] = useState<string | null>(null);

  const apps = useQuery({
    queryKey: ['integration-apps', organizationSlug],
    queryFn: () => listIntegrationApps(api, organizationSlug),
    enabled: open,
  });
  const rows: readonly IntegrationAppView[] = apps.data ?? [];
  const activeApp = rows.find((app) => app.id === activeAppId) ?? null;
  const records = rows.flatMap((app) => app.connections.map((connection) => ({ app, connection })));

  const record = useMutation({
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
      setRecorded(connection.label);
      setLabel('');
      setSettingKey('');
      setSettingValue('');
      await queryClient.invalidateQueries({ queryKey: ['integration-apps', organizationSlug] });
    },
  });
  const canRecord = activeApp !== null && label.trim() !== '' && !record.isPending;

  return (
    <details
      className="tm-int-advanced"
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="tm-int-advanced__summary">{tr(`${KEY}.advanced`, 'Advanced')}</summary>
      <div className="tm-int-advanced__body tm-stack">
        <p className="tm-int-card__hint">
          {tr(
            `${KEY}.advancedHint`,
            'Record a connection by hand, with a label and one setting. It holds no password or key, and it does not sign in to the app. Most companies never need this.',
          )}
        </p>

        {apps.isError ? (
          <InlineAlert tone="danger" title={t('IntegrationDirectoryScreen.loadErrorTitle')} live>
            {describeError(apps.error)}
          </InlineAlert>
        ) : null}

        {records.length > 0 ? (
          <ul
            className="tm-int-advanced__records"
            aria-label={tr(`${KEY}.recordedHeading`, 'Recorded by hand')}
          >
            {records.map(({ app, connection }) => (
              <li key={connection.id}>
                <span>
                  {app.name} · <span className="tm-aut-mono">{connection.label}</span>
                </span>
                <span className="tm-aut-mono">
                  {localizedRelativeAgo(connection.createdAt, tr, locale)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {recorded ? (
          <InlineAlert
            tone="success"
            title={t('IntegrationDirectoryScreen.connectionRecorded')}
            live
          >
            &ldquo;{recorded}&rdquo; {tr(`${KEY}.recordedBody`, 'was recorded.')}
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <form
            className="tm-stack"
            noValidate
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (canRecord && activeApp) record.mutate(activeApp);
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

            {record.isError ? (
              <InlineAlert
                tone="danger"
                title={t('IntegrationDirectoryScreen.connectErrorTitle')}
                live
              >
                {describeError(record.error)}
              </InlineAlert>
            ) : null}

            <div className="tm-aut-actions">
              <Button
                type="submit"
                tone="outline"
                loading={record.isPending}
                loadingLabel={t('IntegrationDirectoryScreen.connecting')}
                disabled={!canRecord}
              >
                {tr(`${KEY}.recordButton`, 'Record connection')}
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </details>
  );
}
