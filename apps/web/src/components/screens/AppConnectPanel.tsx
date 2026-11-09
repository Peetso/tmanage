'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import {
  APP_CONNECT_PROVIDERS,
  completeAppConnect,
  disconnectAppConnect,
  getAppConnect,
  readAppConnectReturn,
  type AppConnectProvider,
  type AppConnectView,
} from '../../lib/api/app-connect';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useDescribeApiError } from '../../lib/api/describe-error';

/**
 * FIX5 — the rest of one-click Connect for GitHub, on the Integrations page under the cards
 * (owners and admins only; the page decides). Slack and Microsoft Teams were removed (Peter,
 * 2026-11-10).
 *
 * - Finishes the provider's return (`#github=complete&code=…&state=…`) under the owner's session.
 * - Disconnect: GitHub forgets TManage's access.
 * - **Advanced** keeps the older way: a GitHub access token.
 */

export const appConnectKey = (slug: string, provider: AppConnectProvider) =>
  ['app-connect', slug, provider] as const;

const NAMES: Readonly<Record<AppConnectProvider, string>> = {
  github: 'GitHub',
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
  onGithubKey,
}: {
  api: ApiClient;
  organizationSlug: string;
  /** FIX5 item 6c: opens GitHub's key panel on this page (it is no longer listed as a row). */
  onGithubKey?: () => void;
}) {
  const tr = useTOr();
  const describeError = useDescribeApiError();
  const queries = useQueryClient();
  const github = useAppConnectStatus(api, organizationSlug, 'github', true);
  const views: Readonly<Record<AppConnectProvider, AppConnectView | undefined>> = {
    github: github.data,
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
    onSuccess: (view) => {
      queries.setQueryData(appConnectKey(organizationSlug, view.provider), view);
      setOutcome({ provider: view.provider, ok: true });
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
          {tr(`${K}.success`, '{app} is connected.').replace('{app}', NAMES[outcome.provider])}
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
          {tr(`${K}.advanced`, 'Another way to connect GitHub')}
        </summary>
        <div className="tm-int-advanced__body tm-stack">
          <p className="tm-int-card__hint">
            {tr(
              `${K}.advancedHint`,
              'Most companies only need Connect. If you already have a GitHub access token, you can still use it.',
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
                {onGithubKey ? (
                  <button type="button" className="tm-aut-btn" onClick={onGithubKey}>
                    {tr(`${K}.open`, 'Open')}
                  </button>
                ) : (
                  <Link
                    href={`/${organizationSlug}/automations/apps#tm-int-keys`}
                    className="tm-aut-btn"
                  >
                    {tr(`${K}.open`, 'Open')}
                  </Link>
                )}
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

      {disconnect.isError ? (
        <InlineAlert tone="danger" live>
          {describeError(disconnect.error)}
        </InlineAlert>
      ) : null}

      <div className="tm-aut-actions">
        {confirming ? (
          <>
            <span className="tm-aut-rowsub">
              {tr(
                `${K}.disconnectConfirmGithub`,
                'TManage forgets its access to your GitHub account. Repository webhooks keep working.',
              )}
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
