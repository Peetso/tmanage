'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { InlineAlert } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import {
  completeCalendarConnect,
  disconnectCalendar,
  getCalendarTeam,
  readCalendarReturn,
  startCalendarConnect,
  type CalendarProviderId,
} from '../../lib/api/calendar-connections';
import { listMembers } from '../../lib/api/members';
import { fillTemplate } from '../../lib/ai-approval-presentation';
import { useOrganizationRole } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';
import { calendarName, initialsOf } from './MeetingBits';
import { useCalendarAccounts, type CalendarAccount } from './use-meetings-data';
import {
  conferenceFor,
  effectiveMeetingDefaults,
  readMeetingDefaults,
  writeMeetingDefaults,
  type MeetingDefaults,
} from './meeting-defaults';
import './meetings.css';
import { BrandLogo } from '../brand/BrandLogo';

/**
 * After a connect or disconnect: the person's own connections and the owners' team card both
 * read the connection rows, so both are refetched — or a disconnected calendar still shows as
 * Connected in "Your team's calendars" (FIX2, live 2026-11-09).
 */
export function refreshCalendarQueries(queries: QueryClient, organizationSlug: string): void {
  void queries.invalidateQueries({ queryKey: ['calendar-connection', organizationSlug] });
  void queries.invalidateQueries({ queryKey: ['calendar-team', organizationSlug] });
}

export interface CalendarConnectionsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
  /** Fixed "now" for stories and tests. */
  now?: Date;
}

const OWNER_ROLES = new Set(['owner', 'org_admin', 'admin']);

/**
 * **Settings › Calendar connections (approved Figma 419:23295).** The person's own Google and
 * Microsoft calendars — connect, reconnect, disconnect — with the copy that invitations go out
 * from their own calendar; their defaults for new meetings; and, for owners, who on the team is
 * connected. Microsoft shows only once its backend answers as configured. The provider callback
 * returns here with `#gcal=…` / `#mscal=…`, which is completed and then cleared from the address.
 */
export function CalendarConnectionsScreen({
  organizationSlug,
  organizationName,
  client,
  now: fixedNow,
}: CalendarConnectionsScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const queries = useQueryClient();
  const [now] = useState(() => fixedNow ?? new Date());
  const { accounts, loaded } = useCalendarAccounts(api, organizationSlug);
  const role = useOrganizationRole(organizationSlug);
  const isOwner =
    role.known &&
    ((role.role !== undefined && OWNER_ROLES.has(role.role)) ||
      (role.capabilities ?? []).includes('org.manage'));
  const [returnError, setReturnError] = useState<CalendarProviderId | null>(null);

  const refresh = () => refreshCalendarQueries(queries, organizationSlug);

  const connect = useMutation({
    mutationFn: (provider: CalendarProviderId) =>
      startCalendarConnect(api, organizationSlug, provider),
    onSuccess: ({ url }) => {
      globalThis.location.assign(url);
    },
  });
  const disconnect = useMutation({
    mutationFn: (provider: CalendarProviderId) =>
      disconnectCalendar(api, organizationSlug, provider),
    onSuccess: refresh,
  });
  const complete = useMutation({
    mutationFn: (input: { provider: CalendarProviderId; code: string; state: string }) =>
      completeCalendarConnect(api, organizationSlug, input.provider, input),
    onSuccess: refresh,
    onError: (_error, input) => setReturnError(input.provider),
  });

  // The provider's return: finish once, then drop the code from the address bar.
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current) return;
    const back = readCalendarReturn(globalThis.location?.hash ?? '');
    if (!back) return;
    handled.current = true;
    globalThis.history?.replaceState(null, '', globalThis.location.pathname);
    if (back.kind === 'error') setReturnError(back.provider);
    else complete.mutate(back);
  }, [complete]);

  return (
    <SettingsShell
      section="calendar-connections"
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="settings"
      title={t('CalendarConnections.title')}
      eyebrow={t('CalendarConnections.eyebrow').toUpperCase()}
    >
      <div className="tm-mtg tm-mtg-settings">
        <div className="tm-mtg-settings__main">
          <p className="tm-mtg-lede">{t('CalendarConnections.lede')}</p>
          {returnError ? (
            <InlineAlert tone="danger" title={t('CalendarConnections.connectFailed')} live>
              {complete.error instanceof ApiRequestError
                ? complete.error.message
                : fillTemplate(t('CalendarConnections.connectFailedBody'), {
                    calendar: calendarName(returnError),
                  })}
            </InlineAlert>
          ) : null}
          {loaded && accounts.length === 0 ? (
            <InlineAlert tone="neutral" title={t('CalendarConnections.notConfigured')}>
              {t('CalendarConnections.notConfiguredBody')}
            </InlineAlert>
          ) : null}

          <div className="tm-mtg-connect-grid">
            {accounts.map((account) => (
              <AccountCard
                key={account.provider}
                account={account}
                now={now}
                busy={connect.isPending || disconnect.isPending || complete.isPending}
                onConnect={() => connect.mutate(account.provider)}
                onDisconnect={() => disconnect.mutate(account.provider)}
              />
            ))}
          </div>

          {accounts.some((a) => a.status === 'connected') ? <Defaults accounts={accounts} /> : null}

          {isOwner ? <TeamCalendars api={api} organizationSlug={organizationSlug} /> : null}
        </div>
      </div>
    </SettingsShell>
  );
}

function AccountCard({
  account,
  now,
  busy,
  onConnect,
  onDisconnect,
}: {
  account: CalendarAccount;
  now: Date;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const t = useT();
  const name = calendarName(account.provider);
  const microsoft = account.provider === 'microsoft';
  const minutes = account.lastSyncedAt
    ? Math.max(0, Math.round((now.getTime() - Date.parse(account.lastSyncedAt)) / 60_000))
    : null;
  return (
    <section className="tm-mtg-card tm-mtg-account" aria-labelledby={`tm-cc-${account.provider}`}>
      <div className="tm-mtg-card__head">
        <h2 id={`tm-cc-${account.provider}`} className="tm-mtg-account__name">
          <BrandLogo
            brand={microsoft ? 'outlook' : 'google-calendar'}
            size={24}
            className="tm-brand-logo--inline"
          />
          {name}
        </h2>
        <span className="tm-mtg-status" data-status={account.status}>
          {t(STATUS_KEYS[account.status])}
        </span>
      </div>
      <p className="tm-mtg-quiet">
        {t(microsoft ? 'CalendarConnections.msWhat' : 'CalendarConnections.gWhat')}
      </p>
      {account.status === 'connected' ? (
        <p className="tm-mtg-account__line" data-status="connected">
          <span className="tm-mtg-dot" aria-hidden="true" />
          {fillTemplate(t('CalendarConnections.signedInAs'), { email: account.accountEmail ?? '' })}
          {minutes !== null
            ? ` · ${fillTemplate(t('CalendarConnections.syncedAgo'), { n: String(minutes) })}`
            : ''}
        </p>
      ) : null}
      {account.status === 'error' ? (
        <p className="tm-mtg-account__line" data-status="error">
          <span className="tm-mtg-dot" aria-hidden="true" />
          {fillTemplate(t('CalendarConnections.signInAgain'), {
            provider: microsoft ? 'Microsoft' : 'Google',
            what: microsoft ? 'Teams' : 'Google Meet',
          })}
        </p>
      ) : null}
      <div className="tm-mtg-account__actions">
        {account.status === 'connected' ? (
          <button
            type="button"
            className="tm-mtg-btn tm-mtg-btn--outline"
            onClick={onDisconnect}
            disabled={busy}
          >
            {t('CalendarConnections.disconnect')}
          </button>
        ) : (
          <button
            type="button"
            className="tm-mtg-btn tm-mtg-btn--ink"
            onClick={onConnect}
            disabled={busy}
          >
            {account.status === 'error'
              ? t('CalendarConnections.reconnect')
              : fillTemplate(t('MeetingsHub.connectNamed'), { provider: name })}
          </button>
        )}
        {account.status === 'error' ? (
          <button type="button" className="tm-mtg-textlink" onClick={onDisconnect} disabled={busy}>
            {t('CalendarConnections.disconnect')}
          </button>
        ) : null}
        {account.status === 'connected' ? (
          <a
            className="tm-mtg-textlink"
            href={
              microsoft ? 'https://outlook.office.com/calendar/' : 'https://calendar.google.com/'
            }
            target="_blank"
            rel="noopener noreferrer"
          >
            {fillTemplate(t('CalendarConnections.openNamed'), { name })}
          </a>
        ) : null}
      </div>
    </section>
  );
}

const STATUS_KEYS = {
  connected: 'CalendarConnections.connected',
  error: 'CalendarConnections.needsReconnect',
  not_connected: 'MeetingsHub.notConnected',
} as const;

/** "Defaults for new meetings" — kept in this browser; the New meeting form starts from them. */
function Defaults({ accounts }: { accounts: readonly CalendarAccount[] }) {
  const t = useT();
  const connected = accounts.filter((a) => a.status === 'connected');
  const connectedProviders = connected.map((a) => a.provider);
  const [stored, setStored] = useState<MeetingDefaults>(() => readMeetingDefaults());
  // The video call always matches the calendar new meetings go to (Outlook makes Teams calls,
  // Google Calendar makes Meet links), including after a calendar is disconnected.
  const defaults = effectiveMeetingDefaults(stored, connectedProviders);
  const update = (next: MeetingDefaults) => {
    const applied = effectiveMeetingDefaults(next, connectedProviders);
    setStored(applied);
    writeMeetingDefaults(applied);
  };
  const conferenceKey = `${defaults.provider ?? ''}:${defaults.conference ?? ''}`;
  const storedKey = `${stored.provider ?? ''}:${stored.conference ?? ''}`;
  useEffect(() => {
    // Keep the saved defaults (read by the New meeting form) in step with what is shown.
    if (connected.length > 0 && conferenceKey !== storedKey) writeMeetingDefaults(defaults);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conferenceKey, storedKey, connected.length]);
  const conferenceOptions: (readonly ['google_meet' | 'teams' | 'none', string, string])[] = [
    ...(defaults.provider === null
      ? []
      : [
          [
            conferenceFor(defaults.provider),
            defaults.provider === 'microsoft' ? 'Microsoft Teams' : 'Google Meet',
            t(
              defaults.provider === 'microsoft'
                ? 'CalendarConnections.madeFromMs'
                : 'CalendarConnections.madeFromGoogle',
            ),
          ] as const,
        ]),
    ['none', t('MeetingsHub.noVideo'), t('CalendarConnections.addPerMeeting')],
  ];
  const conference = defaults.conference ?? 'none';
  return (
    <section className="tm-mtg-card" aria-labelledby="tm-cc-defaults">
      <h2 id="tm-cc-defaults" className="tm-mtg-card__title">
        {t('CalendarConnections.defaults')}
      </h2>
      <div className="tm-mtg-field">
        <label className="tm-mtg-label" htmlFor="tm-cc-calendar">
          {t('CalendarConnections.newMeetingsGoTo')}
        </label>
        <select
          id="tm-cc-calendar"
          className="tm-mtg-input"
          value={defaults.provider ?? ''}
          onChange={(event) => {
            const provider = event.target.value === 'microsoft' ? 'microsoft' : 'google';
            // A new destination brings its own video call (unless "No video call" was chosen).
            update({
              ...defaults,
              provider,
              conference: defaults.conference === 'none' ? 'none' : conferenceFor(provider),
            });
          }}
        >
          {connected.map((a) => (
            <option key={a.provider} value={a.provider}>
              {calendarName(a.provider)} · {a.accountEmail ?? ''}
            </option>
          ))}
        </select>
      </div>
      <div className="tm-mtg-field">
        <span className="tm-mtg-label" id="tm-cc-video">
          {t('MeetingForm.videoCall')}
        </span>
        <div className="tm-mtg-radios" role="radiogroup" aria-labelledby="tm-cc-video">
          {conferenceOptions.map(([value, label, hint]) => (
            // eslint-disable-next-line jsx-a11y/label-has-associated-control -- the option's name is in its <strong>, one level deeper than the rule looks
            <label
              key={value}
              className="tm-mtg-radio"
              data-checked={conference === value || undefined}
            >
              <input
                type="radio"
                name="tm-cc-conference"
                checked={conference === value}
                onChange={() => update({ ...defaults, conference: value })}
              />
              <span>
                <strong>{label}</strong>
                <small>{hint}</small>
              </span>
            </label>
          ))}
        </div>
      </div>
      <div className="tm-mtg-field">
        <label className="tm-mtg-label" htmlFor="tm-cc-reminder">
          {t('CalendarConnections.reminder')}
        </label>
        <select
          id="tm-cc-reminder"
          className="tm-mtg-input tm-mtg-input--auto"
          value={defaults.reminderMinutes}
          onChange={(event) => update({ ...defaults, reminderMinutes: Number(event.target.value) })}
        >
          {[5, 10, 15, 30, 60, 1440].map((minutes) => (
            <option key={minutes} value={minutes}>
              {fillTemplate(t('CalendarConnections.reminderOption'), {
                n: String(minutes >= 60 ? minutes / 60 : minutes),
                unit: t(minutes >= 60 ? 'MeetingForm.unitHours' : 'MeetingForm.unitMinutes'),
              })}
            </option>
          ))}
        </select>
      </div>
      <p className="tm-mtg-hint">{t('CalendarConnections.defaultsHint')}</p>
    </section>
  );
}

/** Owners: who on the team has which calendar connected (no addresses, no tokens). */
function TeamCalendars({ api, organizationSlug }: { api: ApiClient; organizationSlug: string }) {
  const t = useT();
  const team = useQuery({
    queryKey: ['calendar-team', organizationSlug],
    queryFn: () => getCalendarTeam(api, organizationSlug),
    retry: false,
  });
  const members = useQuery({
    queryKey: ['members', organizationSlug, 'calendar-team'],
    queryFn: () => listMembers(api, organizationSlug, { limit: 200 }),
    retry: false,
  });
  if (team.isError) return null;
  const byUser = new Map<string, { provider: string; status: string }[]>();
  for (const c of team.data?.connections ?? []) {
    byUser.set(c.userId, [...(byUser.get(c.userId) ?? []), c]);
  }
  return (
    <section className="tm-mtg-card" aria-labelledby="tm-cc-team">
      <div className="tm-mtg-card__head">
        <h2 id="tm-cc-team" className="tm-mtg-card__title">
          {t('CalendarConnections.teamTitle')}
        </h2>
        <span className="tm-mtg-tag tm-mtg-mono">{t('CalendarConnections.ownersOnly')}</span>
      </div>
      <ul className="tm-mtg-guests">
        {(members.data?.members ?? []).map((member) => {
          const rows = (byUser.get(member.userId) ?? []).filter((c) => c.status !== 'disconnected');
          const best = rows.find((c) => c.status === 'connected') ?? rows[0];
          const status = best
            ? best.status === 'connected'
              ? 'connected'
              : 'error'
            : 'not_connected';
          return (
            <li key={member.userId} className="tm-mtg-guest">
              <span className="tm-mtg-avatar" aria-hidden="true">
                {initialsOf(member.displayName)}
              </span>
              <span className="tm-mtg-guest__who">
                <strong>{member.displayName}</strong>
                <small>
                  {best ? calendarName(best.provider) : t('CalendarConnections.noCalendarYet')}
                </small>
              </span>
              <span className="tm-mtg-status" data-status={status}>
                {t(STATUS_KEYS[status])}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="tm-mtg-hint">{t('CalendarConnections.teamFoot')}</p>
    </section>
  );
}
