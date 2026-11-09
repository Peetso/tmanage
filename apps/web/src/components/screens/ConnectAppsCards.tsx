'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, StateCapsule } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import {
  completeCalendarConnect,
  disconnectCalendar,
  getGoogleCalendarStatus,
  getMicrosoftCalendarStatus,
  readCalendarReturn,
  startCalendarConnect,
  type CalendarProviderId,
} from '../../lib/api/calendar-connections';
import { getConnectSetup } from '../../lib/api/connect-setup';
import {
  completeDriveConnect,
  getStorageStatus,
  readDriveReturn,
  startDriveConnect,
} from '../../lib/api/google-drive';
import {
  completeOneDriveConnect,
  getOneDriveStatus,
  readOneDriveReturn,
  startOneDriveConnect,
} from '../../lib/api/onedrive';
import { fetchPlatformMe } from '../../lib/api/platform-admin';
import { fillTemplate } from '../../lib/ai-approval-presentation';
import {
  explainConnectFailure,
  providerName,
  type ConnectExplanation,
  type ConnectProvider,
} from '../../lib/connect-apps-explanations';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';
import { useOrganizationRole } from '../../lib/use-organization-names';
import { ConnectSetupGuide } from './ConnectSetupGuide';
import { BrandLogo, type BrandId } from '../brand/BrandLogo';
import '../../styles/screens/connect-apps.css';

type AppId = 'google_calendar' | 'microsoft_calendar' | 'google_drive' | 'onedrive';

interface AppCard {
  readonly id: AppId;
  readonly provider: ConnectProvider;
  readonly brand: BrandId;
  readonly nameKey: MessageKey;
  readonly whatKey: MessageKey;
  /** Company storage: connected by the workspace owner, managed on the Storage screen. */
  readonly storage: boolean;
}

const APPS: readonly AppCard[] = [
  {
    id: 'google_calendar',
    provider: 'google',
    brand: 'google-calendar',
    nameKey: 'ConnectApps.app.googleCalendar.name',
    whatKey: 'ConnectApps.app.googleCalendar.what',
    storage: false,
  },
  {
    id: 'microsoft_calendar',
    provider: 'microsoft',
    brand: 'outlook',
    nameKey: 'ConnectApps.app.microsoftCalendar.name',
    whatKey: 'ConnectApps.app.microsoftCalendar.what',
    storage: false,
  },
  {
    id: 'google_drive',
    provider: 'google',
    brand: 'google-drive',
    nameKey: 'ConnectApps.app.googleDrive.name',
    whatKey: 'ConnectApps.app.googleDrive.what',
    storage: true,
  },
  {
    id: 'onedrive',
    provider: 'microsoft',
    brand: 'onedrive',
    nameKey: 'ConnectApps.app.onedrive.name',
    whatKey: 'ConnectApps.app.onedrive.what',
    storage: true,
  },
];

/** One card's state, already reduced to what the person can do. */
interface CardState {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly broken: boolean;
  readonly email: string | null;
}

const CALENDAR_OF: Partial<Record<AppId, CalendarProviderId>> = {
  google_calendar: 'google',
  microsoft_calendar: 'microsoft',
};

type Outcome =
  | { readonly kind: 'success'; readonly app: AppId }
  | { readonly kind: 'failure'; readonly app: AppId; readonly why: ConnectExplanation };

/**
 * R38 · the provider's return to this screen, for any of the four apps: a calendar
 * (`#gcal=…`, `#mscal=…`) or company storage started from here (`#drive=…`, `#onedrive=…`).
 */
export function readConnectAppsReturn(hash: string):
  | {
      readonly kind: 'complete';
      readonly app: AppId;
      readonly code: string;
      readonly state: string;
    }
  | { readonly kind: 'error'; readonly app: AppId }
  | null {
  const calendar = readCalendarReturn(hash);
  if (calendar) {
    const app = appOfCalendar(calendar.provider);
    return calendar.kind === 'complete'
      ? { kind: 'complete', app, code: calendar.code, state: calendar.state }
      : { kind: 'error', app };
  }
  const drive = readDriveReturn(hash);
  if (drive) return { ...drive, app: 'google_drive' };
  const oneDrive = readOneDriveReturn(hash);
  if (oneDrive) return { ...oneDrive, app: 'onedrive' };
  return null;
}

function providerOf(app: AppId): ConnectProvider {
  return app === 'google_calendar' || app === 'google_drive' ? 'google' : 'microsoft';
}

/** `#gcal=error&reason=…` → the provider's reason, if the API forwarded one. */
function reasonFrom(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get('reason');
}

/**
 * R37 · **Connect apps simply** (Figma "R37 Connect apps simply", EN + AR). One card per app: its
 * mark, one plain sentence, one Connect button; then "Connected as …" and Disconnect. When the
 * platform side is not set up the card says "Not available yet" — and the platform owner gets
 * "Set it up", the guided checklist. The provider's return lands back here with a plain-language
 * success or failure; no code, scope or error id is ever shown.
 */
export function ConnectAppsCards({
  api,
  organizationSlug,
}: {
  api: ApiClient;
  organizationSlug: string;
}) {
  const t = useT();
  const queries = useQueryClient();
  const role = useOrganizationRole(organizationSlug);
  const managesCompany =
    role.known &&
    (['owner', 'org_admin', 'admin'].includes(role.role ?? '') ||
      (role.capabilities ?? []).includes('org.manage'));

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
  const drive = useQuery({
    queryKey: ['connect-apps', organizationSlug, 'google-drive'],
    queryFn: () => getStorageStatus(api, organizationSlug),
    retry: false,
  });
  const oneDrive = useQuery({
    queryKey: ['connect-apps', organizationSlug, 'onedrive'],
    queryFn: () => getOneDriveStatus(api, organizationSlug),
    retry: false,
  });
  // The platform owner: a platform admin who may change platform settings. Everyone else gets a
  // 404 here, which simply means "not the owner".
  const me = useQuery({
    queryKey: ['platform-me'],
    queryFn: () => fetchPlatformMe(api),
    retry: false,
  });
  const platformOwner = me.data?.permissions.includes('platform.settings.edit') === true;
  const setup = useQuery({
    queryKey: ['platform-connect-setup'],
    queryFn: () => getConnectSetup(api),
    enabled: platformOwner,
    retry: false,
  });

  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [blocked, setBlocked] = useState<Partial<Record<ConnectProvider, ConnectExplanation>>>({});
  const [guide, setGuide] = useState<ConnectProvider | null>(null);
  const [actionFailed, setActionFailed] = useState(false);

  const state = (app: AppId): CardState | null => {
    switch (app) {
      case 'google_calendar':
        return googleCal.data
          ? {
              configured: googleCal.data.configured,
              connected: googleCal.data.google.status === 'connected',
              broken: googleCal.data.google.status === 'error',
              email: googleCal.data.google.accountEmail,
            }
          : googleCal.isError
            ? { configured: false, connected: false, broken: false, email: null }
            : null;
      case 'microsoft_calendar':
        if (microsoftCal.isPending) return null;
        return microsoftCal.data
          ? {
              configured: microsoftCal.data.configured,
              connected: microsoftCal.data.microsoft.status === 'connected',
              broken: microsoftCal.data.microsoft.status === 'error',
              email: microsoftCal.data.microsoft.accountEmail,
            }
          : { configured: false, connected: false, broken: false, email: null };
      case 'google_drive':
        return drive.data
          ? {
              configured: drive.data.configured,
              connected: drive.data.googleDrive.status === 'connected',
              broken: drive.data.googleDrive.status === 'error',
              email: drive.data.googleDrive.accountEmail,
            }
          : drive.isError
            ? { configured: false, connected: false, broken: false, email: null }
            : null;
      case 'onedrive':
        return oneDrive.data
          ? {
              configured: oneDrive.data.configured,
              connected: oneDrive.data.oneDrive.status === 'connected',
              broken: oneDrive.data.oneDrive.status === 'error',
              email: oneDrive.data.oneDrive.accountEmail,
            }
          : oneDrive.isError
            ? { configured: false, connected: false, broken: false, email: null }
            : null;
    }
  };

  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['calendar-connection', organizationSlug] });
    void queries.invalidateQueries({ queryKey: ['connect-apps', organizationSlug] });
  };

  const connect = useMutation({
    mutationFn: async (app: AppId) => {
      const calendar = CALENDAR_OF[app];
      if (calendar) return startCalendarConnect(api, organizationSlug, calendar);
      // R38: a storage connect started here comes back here, not to the Storage screen.
      if (app === 'google_drive') {
        return startDriveConnect(api, organizationSlug, { returnTo: 'connected-apps' });
      }
      return startOneDriveConnect(api, organizationSlug, { returnTo: 'connected-apps' });
    },
    onMutate: () => {
      setActionFailed(false);
      setOutcome(null);
    },
    onSuccess: ({ url }) => globalThis.location.assign(url),
    onError: () => setActionFailed(true),
  });
  const disconnect = useMutation({
    mutationFn: (provider: CalendarProviderId) =>
      disconnectCalendar(api, organizationSlug, provider),
    onMutate: () => setActionFailed(false),
    onSuccess: refresh,
    onError: () => setActionFailed(true),
  });
  const complete = useMutation({
    mutationFn: async (input: { app: AppId; code: string; state: string }): Promise<unknown> => {
      const body = { code: input.code, state: input.state };
      const calendar = CALENDAR_OF[input.app];
      if (calendar) return completeCalendarConnect(api, organizationSlug, calendar, body);
      if (input.app === 'google_drive') return completeDriveConnect(api, organizationSlug, body);
      return completeOneDriveConnect(api, organizationSlug, body);
    },
    onSuccess: (_result, input) => {
      setOutcome({ kind: 'success', app: input.app });
      refresh();
    },
    onError: (_error, input) =>
      setOutcome({
        kind: 'failure',
        app: input.app,
        why: explainConnectFailure(providerOf(input.app), null),
      }),
  });

  // The provider's return: finish once, then drop the code from the address bar.
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current) return;
    const hash = globalThis.location?.hash ?? '';
    const back = readConnectAppsReturn(hash);
    if (!back) return;
    handled.current = true;
    globalThis.history?.replaceState(null, '', globalThis.location.pathname);
    if (back.kind === 'complete') {
      complete.mutate(back);
      return;
    }
    const provider = providerOf(back.app);
    const why = explainConnectFailure(provider, reasonFrom(hash));
    setOutcome({ kind: 'failure', app: back.app, why });
    if (why.needsSetup) setBlocked((current) => ({ ...current, [provider]: why }));
  }, [complete]);

  const busy = connect.isPending || disconnect.isPending || complete.isPending;
  const outcomeApp = outcome ? APPS.find((app) => app.id === outcome.app) : undefined;
  const outcomeName = outcomeApp ? t(outcomeApp.nameKey) : '';
  const guideProblem = guide ? blocked[guide] : undefined;

  return (
    <section className="tm-connect-apps" aria-labelledby="tm-connect-apps-title">
      <h2 className="tm-connect-apps__title" id="tm-connect-apps-title">
        {t('ConnectApps.heading')}
      </h2>
      <p className="tm-connect-apps__lede">{t('ConnectApps.lede')}</p>

      {outcome?.kind === 'success' ? (
        <InlineAlert tone="success" live>
          {fillTemplate(t('ConnectApps.success'), { app: outcomeName })}
        </InlineAlert>
      ) : null}
      {outcome?.kind === 'failure' && outcomeApp ? (
        <InlineAlert
          tone="danger"
          title={fillTemplate(t('ConnectApps.failedTitle'), { app: outcomeName })}
          live
        >
          {fillTemplate(t(outcome.why.userKey), { provider: providerName(outcomeApp.provider) })}
        </InlineAlert>
      ) : null}
      {actionFailed ? (
        <InlineAlert tone="danger" live>
          {t('ConnectApps.actionError')}
        </InlineAlert>
      ) : null}

      <ul className="tm-connect-apps__grid">
        {APPS.map((app) => {
          const card = state(app.id);
          const name = t(app.nameKey);
          const available = card !== null && card.configured && blocked[app.provider] === undefined;
          const calendar = CALENDAR_OF[app.id];
          return (
            <li key={app.id} className="tm-connect-apps__card" aria-busy={card === null}>
              <div className="tm-connect-apps__identity">
                <BrandLogo brand={app.brand} size={46} />
                <h3 className="tm-connect-apps__name">{name}</h3>
              </div>
              <p className="tm-connect-apps__what">{t(app.whatKey)}</p>
              {card === null ? null : card.connected ? (
                <div className="tm-connect-apps__actions">
                  <StateCapsule state="done">
                    {card.email ? (
                      <>
                        {t('ConnectApps.connectedAs')} <bdi dir="ltr">{card.email}</bdi>
                      </>
                    ) : (
                      t('ConnectApps.connected')
                    )}
                  </StateCapsule>
                  {calendar ? (
                    <Button
                      tone="outline"
                      disabled={busy}
                      loading={disconnect.isPending && disconnect.variables === calendar}
                      loadingLabel={t('ConnectApps.disconnecting')}
                      aria-label={fillTemplate(t('ConnectApps.disconnectLabel'), { app: name })}
                      onClick={() => disconnect.mutate(calendar)}
                    >
                      {t('ConnectApps.disconnect')}
                    </Button>
                  ) : managesCompany ? (
                    <Link
                      className="tm-connect-apps__manage"
                      href={`/${organizationSlug}/admin/storage`}
                    >
                      {t('ConnectApps.manageStorage')}
                    </Link>
                  ) : null}
                </div>
              ) : !available ? (
                platformOwner ? (
                  <div className="tm-connect-apps__actions tm-connect-apps__actions--stack">
                    <StateCapsule state="waiting">{t('ConnectApps.ownerNotSet')}</StateCapsule>
                    <Button
                      tone="ink"
                      aria-label={fillTemplate(t('ConnectApps.setUpLabel'), {
                        provider: providerName(app.provider),
                      })}
                      onClick={() => setGuide(app.provider)}
                    >
                      {t('ConnectApps.setUp')}
                    </Button>
                  </div>
                ) : (
                  <div className="tm-connect-apps__actions tm-connect-apps__actions--stack">
                    <StateCapsule state="waiting">{t('ConnectApps.notAvailable')}</StateCapsule>
                    <p className="tm-connect-apps__hint">{t('ConnectApps.notAvailableBody')}</p>
                  </div>
                )
              ) : app.storage && !managesCompany ? (
                <p className="tm-connect-apps__hint">{t('ConnectApps.ownerOnly')}</p>
              ) : (
                <div className="tm-connect-apps__actions tm-connect-apps__actions--stack">
                  {card.broken ? (
                    <p className="tm-connect-apps__hint">{t('ConnectApps.needsReconnect')}</p>
                  ) : null}
                  <Button
                    tone="lime"
                    disabled={busy && !(connect.isPending && connect.variables === app.id)}
                    loading={connect.isPending && connect.variables === app.id}
                    loadingLabel={t('ConnectApps.connecting')}
                    aria-label={fillTemplate(t('ConnectApps.connectLabel'), { app: name })}
                    onClick={() => connect.mutate(app.id)}
                  >
                    {t('ConnectApps.connect')}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {guide && platformOwner ? (
        <ConnectSetupGuide
          provider={guide}
          setup={setup.data?.providers.find((entry) => entry.provider === guide)}
          publicAddressSet={setup.data?.publicAddressSet ?? true}
          problem={
            guideProblem?.ownerKey
              ? { ownerKey: guideProblem.ownerKey, fixStep: guideProblem.fixStep }
              : null
          }
          checking={setup.isFetching}
          checkFailed={setup.isError}
          onCheck={() => {
            void setup.refetch().then((result) => {
              const entry = result.data?.providers.find((row) => row.provider === guide);
              if (entry?.configured) {
                setBlocked((current) => {
                  const next = { ...current };
                  delete next[guide];
                  return next;
                });
                refresh();
              }
            });
          }}
          onClose={() => setGuide(null)}
        />
      ) : null}
    </section>
  );
}

function appOfCalendar(provider: CalendarProviderId): AppId {
  return provider === 'google' ? 'google_calendar' : 'microsoft_calendar';
}
