'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import {
  APP_CONNECT_PROVIDERS,
  addAppConnectChannel,
  completeAppConnect,
  disconnectAppConnect,
  getAppConnect,
  listAppConnectChannels,
  readAppConnectReturn,
  type AppConnectProvider,
  type AppConnectView,
} from '../../lib/api/app-connect';
import { channelLinksQueryKey } from '../../lib/api/channel-links';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useDescribeApiError } from '../../lib/api/describe-error';

/**
 * FIX5 — the rest of one-click Connect for GitHub, Slack and Microsoft Teams, on the Integrations
 * page under the cards (owners and admins only; the page decides).
 *
 * - Finishes the provider's return (`#slack=complete&code=…&state=…`) under the owner's session.
 * - Slack: notices start in the channel picked on Slack's own screen; "Add a channel" posts to one
 *   more. Teams: pick a team, then a channel.
 * - Disconnect: the provider forgets TManage's access and the bot channels stop.
 * - **Advanced** keeps the older ways: a GitHub access token, a pasted Slack / Teams webhook.
 */

export const appConnectKey = (slug: string, provider: AppConnectProvider) =>
  ['app-connect', slug, provider] as const;

const NAMES: Readonly<Record<AppConnectProvider, string>> = {
  github: 'GitHub',
  slack: 'Slack',
  teams: 'Microsoft Teams',
};

const K = 'AppConnect';

export function useAppConnectStatus(
  api: ApiClient,
  slug: string,
  provider: AppConnectProvider,
  enabled: boolean,
) {
  return useQuery({
    queryKey: appConnectKey(slug, provider),
    queryFn: () => getAppConnect(api, slug, provider),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}

export function AppConnectPanel({
  api,
  organizationSlug,
}: {
  api: ApiClient;
  organizationSlug: string;
}) {
  const tr = useTOr();
  const describeError = useDescribeApiError();
  const queries = useQueryClient();
  const github = useAppConnectStatus(api, organizationSlug, 'github', true);
  const slack = useAppConnectStatus(api, organizationSlug, 'slack', true);
  const teams = useAppConnectStatus(api, organizationSlug, 'teams', true);
  const views: Readonly<Record<AppConnectProvider, AppConnectView | undefined>> = {
    github: github.data,
    slack: slack.data,
    teams: teams.data,
  };
  const [outcome, setOutcome] = useState<{
    readonly provider: AppConnectProvider;
    readonly ok: boolean;
  } | null>(null);

  const complete = useMutation({
    mutationFn: (back: {
      provider: AppConnectProvider;
      code: string;
      state: string;
    }): Promise<AppConnectView> =>
      completeAppConnect(api, organizationSlug, back.provider, {
        code: back.code,
        state: back.state,
      }),
    onSuccess: async (view) => {
      queries.setQueryData(appConnectKey(organizationSlug, view.provider), view);
      setOutcome({ provider: view.provider, ok: true });
      await queries.invalidateQueries({ queryKey: channelLinksQueryKey(organizationSlug) });
    },
    onError: (_error, back) => setOutcome({ provider: back.provider, ok: false }),
  });

  const handled = useRef(false);
  useEffect(() => {
    if (handled.current) return;
    const back = readAppConnectReturn(globalThis.location?.hash ?? '');
    if (!back) return;
    handled.current = true;
    globalThis.history?.replaceState(null, '', globalThis.location.pathname);
    if (back.kind === 'complete') complete.mutate(back);
    else setOutcome({ provider: back.provider, ok: false });
  }, [complete]);

  const connected = APP_CONNECT_PROVIDERS.filter((p) => views[p]?.connected === true);

  return (
    <section className="tm-aut-col" aria-labelledby="tm-app-connect-heading">
      {outcome?.ok === true ? (
        <InlineAlert tone="success" live>
          {outcome.provider === 'teams'
            ? tr(
                `${K}.successTeams`,
                'Microsoft Teams is connected. Pick the channel for your notices below.',
              )
            : outcome.provider === 'slack'
              ? tr(
                  `${K}.successSlack`,
                  'Slack is connected. Notices now go to the channel you picked.',
                )
              : tr(`${K}.success`, '{app} is connected.').replace('{app}', NAMES[outcome.provider])}
        </InlineAlert>
      ) : outcome?.ok === false ? (
        <InlineAlert
          tone="danger"
          title={tr(`${K}.failedTitle`, "{app} isn't connected").replace(
            '{app}',
            NAMES[outcome.provider],
          )}
          live
        >
          {complete.isError
            ? describeError(complete.error)
            : tr(
                `${K}.failedBody`,
                '{app} did not finish the sign-in, so nothing was changed. Press Connect to try again.',
              ).replace('{app}', NAMES[outcome.provider])}
        </InlineAlert>
      ) : null}

      {connected.length > 0 ? (
        <>
          <h2 id="tm-app-connect-heading" className="tm-aut-section-head__title">
            {tr(`${K}.heading`, 'Your connected apps')}
          </h2>
          <ul className="tm-aut-list">
            {connected.map((provider) => (
              <ConnectedRow
                key={provider}
                api={api}
                organizationSlug={organizationSlug}
                view={views[provider] as AppConnectView}
              />
            ))}
          </ul>
        </>
      ) : (
        <h2 id="tm-app-connect-heading" className="tm-visually-hidden">
          {tr(`${K}.heading`, 'Your connected apps')}
        </h2>
      )}

      <details className="tm-int-advanced">
        <summary className="tm-int-advanced__summary">
          {tr(`${K}.advanced`, 'Other ways to connect GitHub, Slack and Teams')}
        </summary>
        <div className="tm-int-advanced__body tm-stack">
          <p className="tm-int-card__hint">
            {tr(
              `${K}.advancedHint`,
              'Most companies only need Connect. If you already have a GitHub access token, or a Slack or Teams webhook link, you can still use it.',
            )}
          </p>
          <ul className="tm-aut-list">
            <li>
              <div className="tm-aut-list__main">
                <span className="tm-aut-rowtitle">
                  {tr(`${K}.advancedGithub`, 'GitHub with an access token')}
                </span>
              </div>
              <div className="tm-aut-list__end">
                <Link
                  href={`/${organizationSlug}/automations/apps#tm-int-keys`}
                  className="tm-aut-btn"
                >
                  {tr(`${K}.open`, 'Open')}
                </Link>
              </div>
            </li>
            <li>
              <div className="tm-aut-list__main">
                <span className="tm-aut-rowtitle">
                  {tr(`${K}.advancedWebhook`, 'Slack or Teams with a webhook link')}
                </span>
              </div>
              <div className="tm-aut-list__end">
                <Link href={`/${organizationSlug}/settings/channel-notices`} className="tm-aut-btn">
                  {tr(`${K}.open`, 'Open')}
                </Link>
              </div>
            </li>
          </ul>
        </div>
      </details>
    </section>
  );
}

function ConnectedRow({
  api,
  organizationSlug,
  view,
}: {
  api: ApiClient;
  organizationSlug: string;
  view: AppConnectView;
}) {
  const tr = useTOr();
  const describeError = useDescribeApiError();
  const queries = useQueryClient();
  const name = NAMES[view.provider];
  const [confirming, setConfirming] = useState(false);
  const disconnect = useMutation({
    mutationFn: () => disconnectAppConnect(api, organizationSlug, view.provider),
    onSuccess: async (next) => {
      queries.setQueryData(appConnectKey(organizationSlug, view.provider), next);
      setConfirming(false);
      await queries.invalidateQueries({ queryKey: channelLinksQueryKey(organizationSlug) });
      await queries.invalidateQueries({ queryKey: ['connectors', organizationSlug] });
    },
  });

  return (
    <li id={`tm-app-connect-${view.provider}`} className="tm-stack">
      <div className="tm-aut-list__main">
        <h3 className="tm-aut-rowtitle">
          <bdi dir="ltr">{name}</bdi>
        </h3>
        <span className="tm-aut-rowsub">
          {view.account ? (
            <>
              {tr(`${K}.connectedAs`, 'Connected as')} <bdi dir="ltr">{view.account}</bdi>
            </>
          ) : (
            tr(`${K}.connected`, 'Connected')
          )}
        </span>
      </div>

      {view.provider === 'slack' || view.provider === 'teams' ? (
        <ChannelPicker
          api={api}
          organizationSlug={organizationSlug}
          provider={view.provider}
          current={view.channel}
        />
      ) : null}

      {disconnect.isError ? (
        <InlineAlert tone="danger" live>
          {describeError(disconnect.error)}
        </InlineAlert>
      ) : null}

      <div className="tm-aut-actions">
        {confirming ? (
          <>
            <span className="tm-aut-rowsub">
              {view.provider === 'github'
                ? tr(
                    `${K}.disconnectConfirmGithub`,
                    'TManage will stop reading your GitHub issues and pull requests.',
                  )
                : tr(
                    `${K}.disconnectConfirmChannels`,
                    'Notices stop going to {app}. Channels you linked with a webhook keep working.',
                  ).replace('{app}', name)}
            </span>
            <Button
              tone="outline"
              loading={disconnect.isPending}
              loadingLabel={tr(`${K}.disconnecting`, 'Disconnecting…')}
              onClick={() => disconnect.mutate()}
            >
              {tr(`${K}.disconnectYes`, 'Yes, disconnect')}
            </Button>
            <Button tone="text" onClick={() => setConfirming(false)}>
              {tr(`${K}.cancel`, 'Cancel')}
            </Button>
          </>
        ) : (
          <Button
            tone="outline"
            aria-label={tr(`${K}.disconnectLabel`, 'Disconnect {app}').replace('{app}', name)}
            onClick={() => setConfirming(true)}
          >
            {tr(`${K}.disconnect`, 'Disconnect')}
          </Button>
        )}
      </div>
    </li>
  );
}

function ChannelPicker({
  api,
  organizationSlug,
  provider,
  current,
}: {
  api: ApiClient;
  organizationSlug: string;
  provider: 'slack' | 'teams';
  current: string | null;
}) {
  const tr = useTOr();
  const locale = useActiveLocale();
  const describeError = useDescribeApiError();
  const queries = useQueryClient();
  const [teamId, setTeamId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [added, setAdded] = useState<string | null>(null);

  const teams = useQuery({
    queryKey: ['app-connect-teams', organizationSlug],
    queryFn: () => listAppConnectChannels(api, organizationSlug, 'teams'),
    enabled: provider === 'teams',
    retry: false,
  });
  const channels = useQuery({
    queryKey: ['app-connect-channels', organizationSlug, provider, teamId],
    queryFn: () =>
      listAppConnectChannels(
        api,
        organizationSlug,
        provider,
        provider === 'teams' ? teamId : undefined,
      ),
    enabled: provider === 'slack' || teamId !== '',
    retry: false,
  });
  const add = useMutation({
    mutationFn: () =>
      addAppConnectChannel(api, organizationSlug, provider, {
        channelId,
        ...(provider === 'teams' ? { teamId } : {}),
        locale: locale.startsWith('ar') ? 'ar' : 'en',
      }),
    onSuccess: async (link) => {
      setAdded(link.label ?? '');
      setChannelId('');
      await queries.invalidateQueries({ queryKey: channelLinksQueryKey(organizationSlug) });
    },
  });

  const failure = teams.error ?? channels.error ?? add.error;
  const teamOptions = teams.data?.teams ?? [];
  const channelOptions = channels.data?.channels ?? [];
  const teamSelect = `tm-app-connect-${provider}-team`;
  const channelSelect = `tm-app-connect-${provider}-channel`;

  return (
    <div className="tm-stack">
      {provider === 'slack' && current ? (
        <p className="tm-int-card__hint">
          {tr(`${K}.slackCurrent`, 'Notices go to #{channel}.').replace('{channel}', current)}
        </p>
      ) : null}
      {added !== null ? (
        <InlineAlert tone="success" live>
          {tr(`${K}.channelAdded`, 'Notices now also go to {channel}.').replace('{channel}', added)}
        </InlineAlert>
      ) : null}
      {failure ? (
        <InlineAlert tone="danger" live>
          {describeError(failure)}
        </InlineAlert>
      ) : null}

      {provider === 'teams' ? (
        <div className="tm-field">
          <label className="tm-field__label" htmlFor={teamSelect}>
            {tr(`${K}.team`, 'Team')}
          </label>
          <select
            id={teamSelect}
            className="tm-field__control"
            value={teamId}
            disabled={teams.isPending}
            onChange={(event) => {
              setTeamId(event.target.value);
              setChannelId('');
            }}
          >
            <option value="">{tr(`${K}.chooseTeam`, 'Choose a team')}</option>
            {teamOptions.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {provider === 'slack' || teamId !== '' ? (
        <div className="tm-field">
          <label className="tm-field__label" htmlFor={channelSelect}>
            {provider === 'slack'
              ? tr(`${K}.addChannelLabel`, 'Also post to')
              : tr(`${K}.channel`, 'Channel')}
          </label>
          <select
            id={channelSelect}
            className="tm-field__control"
            value={channelId}
            disabled={channels.isPending}
            onChange={(event) => setChannelId(event.target.value)}
          >
            <option value="">{tr(`${K}.chooseChannel`, 'Choose a channel')}</option>
            {channelOptions.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {provider === 'slack' ? `#${channel.name}` : channel.name}
              </option>
            ))}
          </select>
          {provider === 'slack' ? (
            <p className="tm-field__hint">
              {tr(
                `${K}.slackInviteHint`,
                'If notices do not arrive in a channel, type /invite @TManage in it.',
              )}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="tm-aut-actions">
        <Button
          tone="lime"
          disabled={channelId === '' || add.isPending}
          loading={add.isPending}
          loadingLabel={tr(`${K}.adding`, 'Adding…')}
          onClick={() => add.mutate()}
        >
          {tr(`${K}.postHere`, 'Post notices here')}
        </Button>
        <Link href={`/${organizationSlug}/settings/channel-notices`} className="tm-aut-btn">
          {tr(`${K}.chooseNotices`, 'Choose which notices')}
        </Link>
      </div>
    </div>
  );
}
