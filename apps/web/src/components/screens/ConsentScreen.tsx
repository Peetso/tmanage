'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, InlineAlert, LiveAnnouncer, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import { listOrganizations, type OrganizationSummary } from '../../lib/api/organizations';
import {
  approveConsent,
  denyConsent,
  loadConsent,
  type ConsentParams,
  type ConsentView,
} from '../../lib/api/oauth-consent';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import '../../styles/screens/consent.css';

/**
 * **S0-1 Consent — "Allow <app> to connect?"** (MCP connector S9, Figma 364:1214 / 364:1285,
 * unverified variant 364:1356 / 364:1382).
 *
 * An AI app sent the person here through `/oauth/authorize`. The screen asks the API what the
 * request is (re-validated server-side; nothing in this URL is trusted), then:
 *
 * - an **unverified** app first gets the red "Check before you continue" gate (threat model B2,
 *   consent phishing); only "Continue anyway" reaches the choices;
 * - the person picks the **workspace** the connection is bound to, and the **scopes** — read is
 *   always on, everyday changes on by default, admin and billing opt-in (billing only for owners
 *   and organization admins);
 * - "Allow access" posts the decision with the session-bound ticket; "Cancel" tells the app no.
 *   Both answer with the URL to go to, followed with `location.assign`.
 */

export interface ConsentScreenProps {
  readonly params: ConsentParams;
  readonly client?: ApiClient;
  /** Leaves for the app's redirect. Injected by tests; the real one is `location.assign`. */
  readonly navigate?: (url: string) => void;
  /** Sends a signed-out person to sign-in, returning here afterwards. */
  readonly onSignInRequired?: () => void;
}

const SCOPE_READ = 'tmanage:read';
const SCOPE_WRITE = 'tmanage:write';
const SCOPE_MANAGE = 'tmanage:manage';
const SCOPE_BILLING = 'tmanage:billing';

/** The four rows, in the design's order. */
const SCOPE_ROWS: ReadonlyArray<{
  readonly scope: string;
  readonly title: MessageKey;
  readonly body: MessageKey;
  readonly optIn: boolean;
}> = [
  {
    scope: SCOPE_READ,
    title: k('Consent.scope.read.title'),
    body: k('Consent.scope.read.body'),
    optIn: false,
  },
  {
    scope: SCOPE_WRITE,
    title: k('Consent.scope.write.title'),
    body: k('Consent.scope.write.body'),
    optIn: false,
  },
  {
    scope: SCOPE_MANAGE,
    title: k('Consent.scope.manage.title'),
    body: k('Consent.scope.manage.body'),
    optIn: true,
  },
  {
    scope: SCOPE_BILLING,
    title: k('Consent.scope.billing.title'),
    body: k('Consent.scope.billing.body'),
    optIn: true,
  },
];

const NEVER_KEYS: readonly MessageKey[] = [
  k('Consent.never.signIn'),
  k('Consent.never.tokens'),
  k('Consent.never.delete'),
  k('Consent.never.risky'),
];

/** Roles that may grant billing — mirrors `consent.ts` on the API, which enforces it. */
const BILLING_ROLES: ReadonlySet<string> = new Set(['owner', 'org_admin']);

const ROLE_KEYS: Readonly<Record<string, MessageKey>> = {
  owner: k('Consent.role.owner'),
  org_admin: k('Consent.role.org_admin'),
  workspace_admin: k('Consent.role.workspace_admin'),
  manager: k('Consent.role.manager'),
  moderator: k('Consent.role.moderator'),
  member: k('Consent.role.member'),
  guest: k('Consent.role.guest'),
};

/** The new keys live in `i18n-S9.*.json` until the committer merges them into the catalogs. */
function k(key: string): MessageKey {
  return key as MessageKey;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

export function ConsentScreen({
  params,
  client,
  navigate = (url) => window.location.assign(url),
  onSignInRequired,
}: ConsentScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();

  const view = useQuery({
    queryKey: ['oauth-consent', params],
    queryFn: () => loadConsent(api, params),
    retry: false,
  });
  const organizations = useQuery({
    queryKey: ['organizations'],
    queryFn: () => listOrganizations(api),
    retry: false,
  });

  const signedOut = view.error instanceof ApiRequestError && view.error.status === 401;
  useEffect(() => {
    if (signedOut) onSignInRequired?.();
  }, [signedOut, onSignInRequired]);

  if (view.isPending || (view.isSuccess && organizations.isPending)) {
    return (
      <ConsentFrame>
        <LoadingRegion label={t(k('Consent.loading'))}>
          <Skeleton height="var(--s16)" />
          <Skeleton height="var(--s16)" />
        </LoadingRegion>
      </ConsentFrame>
    );
  }

  if (view.isError || !view.data) {
    return (
      <ConsentFrame>
        <h1 className="tm-consent__title">{t(k('Consent.titleUnverified'))}</h1>
        <InlineAlert tone="danger" title={t(k('Consent.invalidTitle'))} live>
          {t(k('Consent.invalidBody'))}
        </InlineAlert>
      </ConsentFrame>
    );
  }

  const workspaces = (organizations.data ?? []).filter(
    (org) => org.audience === 'internal' && org.suspended !== true,
  );

  return (
    <ConsentDecision
      api={api}
      params={params}
      view={view.data}
      workspaces={workspaces}
      navigate={navigate}
    />
  );
}

function ConsentDecision({
  api,
  params,
  view,
  workspaces,
  navigate,
}: {
  readonly api: ApiClient;
  readonly params: ConsentParams;
  readonly view: ConsentView;
  readonly workspaces: readonly OrganizationSummary[];
  readonly navigate: (url: string) => void;
}) {
  const t = useT();
  const { client } = view;
  const [pastGate, setPastGate] = useState(client.verified);
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id);
  const [picking, setPicking] = useState(false);
  const [failed, setFailed] = useState(false);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () =>
      new Set([
        SCOPE_READ,
        SCOPE_WRITE,
        ...view.requestedScopes.filter((s) => s !== SCOPE_BILLING),
      ]),
  );

  const workspace = workspaces.find((org) => org.id === workspaceId) ?? workspaces[0];
  const billingAllowed = workspace !== undefined && BILLING_ROLES.has(workspace.role);
  const granted = useMemo(
    () => [...chosen].filter((scope) => scope !== SCOPE_BILLING || billingAllowed),
    [chosen, billingAllowed],
  );

  const allow = useMutation({
    mutationFn: () => {
      if (!workspace) throw new Error('no workspace');
      return approveConsent(api, workspace.slug, { params, ticket: view.ticket, scopes: granted });
    },
    onSuccess: navigate,
    onError: () => setFailed(true),
  });
  const cancel = useMutation({
    mutationFn: () => denyConsent(api, params),
    onSuccess: navigate,
    onError: () => setFailed(true),
  });

  const footer = <p className="tm-consent__note">{t(k('Consent.footer'))}</p>;
  const failure = failed ? (
    <InlineAlert tone="danger" live>
      {t(k('Consent.failed'))}
    </InlineAlert>
  ) : null;

  if (!pastGate) {
    return (
      <ConsentFrame>
        <h1 className="tm-consent__title">{t(k('Consent.titleUnverified'))}</h1>
        <ClientCard client={client} gate />
        <section className="tm-consent__check" aria-labelledby="tm-consent-check">
          <p id="tm-consent-check" className="tm-consent__caption tm-consent__caption--danger">
            {t(k('Consent.checkTitle'))}
          </p>
          <p className="tm-consent__check-body">{t(k('Consent.checkBody'))}</p>
        </section>
        {failure}
        <div className="tm-consent__actions">
          <Button tone="outline" className="tm-consent__button" onClick={() => setPastGate(true)}>
            {t(k('Consent.continueAnyway'))}
          </Button>
          <Button
            tone="ink"
            className="tm-consent__button"
            loading={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            {t(k('Consent.cancel'))}
          </Button>
        </div>
        {footer}
      </ConsentFrame>
    );
  }

  const roleKey = workspace ? ROLE_KEYS[workspace.role] : undefined;

  function toggle(scope: string, on: boolean) {
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(scope);
      else next.delete(scope);
      next.add(SCOPE_READ);
      return next;
    });
  }

  return (
    <ConsentFrame>
      <h1 className="tm-consent__title">{fill(t(k('Consent.title')), { app: client.name })}</h1>
      <ClientCard client={client} />

      <section className="tm-consent__workspace" aria-labelledby="tm-consent-workspace">
        <p id="tm-consent-workspace" className="tm-consent__caption">
          {t(k('Consent.workspace'))}
        </p>
        {workspace ? (
          <>
            <button
              type="button"
              className="tm-consent__picker"
              aria-expanded={picking}
              onClick={() => setPicking((open) => !open)}
            >
              <span className="tm-consent__picker-text">
                <span className="tm-consent__picker-name">{workspace.name}</span>
                <span className="tm-consent__picker-sub">
                  {roleKey ? fill(t(k('Consent.youAre')), { role: t(roleKey) }) : null}
                  {` · ${t(k('Consent.change'))}`}
                </span>
              </span>
              <span className="tm-consent__chevron" aria-hidden="true">
                ›
              </span>
            </button>
            {/* The row and "change" always show, as designed; with one workspace the list
                simply holds that one workspace. */}
            {picking ? (
              <ul className="tm-consent__options" aria-label={t(k('Consent.chooseWorkspace'))}>
                {workspaces.map((org) => (
                  <li key={org.id}>
                    <button
                      type="button"
                      className="tm-consent__picker"
                      aria-current={org.id === workspace.id ? 'true' : undefined}
                      onClick={() => {
                        setWorkspaceId(org.id);
                        setPicking(false);
                      }}
                    >
                      <span className="tm-consent__picker-text">
                        <span className="tm-consent__picker-name">{org.name}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <InlineAlert tone="warning">{t(k('Consent.noWorkspace'))}</InlineAlert>
        )}
      </section>

      <h2 className="tm-consent__section">
        {fill(t(k('Consent.abilities')), { app: client.name })}
      </h2>
      <ul className="tm-consent__scopes">
        {SCOPE_ROWS.map((row) => {
          const id = `tm-consent-scope-${row.scope.replace(':', '-')}`;
          const locked = row.scope === SCOPE_READ;
          const unavailable = row.scope === SCOPE_BILLING && !billingAllowed;
          return (
            <li key={row.scope} className="tm-consent__scope">
              <input
                id={id}
                type="checkbox"
                role="switch"
                className="tm-consent__switch"
                checked={locked || (!unavailable && chosen.has(row.scope))}
                disabled={unavailable}
                aria-readonly={locked ? true : undefined}
                aria-describedby={`${id}-body`}
                onChange={(event) => {
                  if (!locked) toggle(row.scope, event.target.checked);
                }}
              />
              <span className="tm-consent__scope-text">
                <label htmlFor={id} className="tm-consent__scope-title">
                  {t(row.title)}
                  {row.optIn ? `  ·  ${t(k('Consent.optIn'))}` : null}
                </label>
                <span id={`${id}-body`} className="tm-consent__scope-body">
                  {t(row.body)}
                </span>
              </span>
            </li>
          );
        })}
      </ul>

      <hr className="tm-consent__rule" />

      <section className="tm-consent__never" aria-labelledby="tm-consent-never">
        <p id="tm-consent-never" className="tm-consent__caption">
          {t(k('Consent.never.title'))}
        </p>
        <ul className="tm-consent__never-list">
          {NEVER_KEYS.map((key) => (
            <li key={key} className="tm-consent__never-item">
              <span className="tm-consent__dash" aria-hidden="true">
                —
              </span>
              <span>{t(key)}</span>
            </li>
          ))}
        </ul>
      </section>

      {failure}
      <div className="tm-consent__actions">
        <Button
          tone="outline"
          className="tm-consent__button"
          loading={cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          {t(k('Consent.cancel'))}
        </Button>
        <Button
          tone="ink"
          className="tm-consent__button"
          disabled={!workspace}
          loading={allow.isPending}
          loadingLabel={t(k('Consent.allowing'))}
          onClick={() => {
            setFailed(false);
            allow.mutate();
          }}
        >
          {t(k('Consent.allow'))}
        </Button>
      </div>
      {footer}
    </ConsentFrame>
  );
}

function ClientCard({
  client,
  gate = false,
}: {
  readonly client: ConsentView['client'];
  readonly gate?: boolean;
}) {
  const t = useT();
  const initial = client.name.trim().charAt(0).toUpperCase() || '?';
  const sub = client.verified
    ? fill(t(k('Consent.byPublisher')), {
        publisher: client.publisher ?? client.redirectHost,
        host: client.redirectHost,
      })
    : gate
      ? t(k('Consent.publisherUnknown'))
      : `${t(k('Consent.publisherUnknown'))} · ${client.redirectHost}`;
  return (
    <div className="tm-consent__client">
      <span className="tm-consent__avatar" aria-hidden="true">
        {initial}
      </span>
      <span className="tm-consent__client-text">
        <span className="tm-consent__client-head">
          <span className="tm-consent__client-name">{client.name}</span>
          <span
            className={
              client.verified
                ? 'tm-consent__badge tm-consent__badge--verified'
                : 'tm-consent__badge tm-consent__badge--unverified'
            }
          >
            {client.verified ? t(k('Consent.verified')) : t(k('Consent.unverified'))}
          </span>
        </span>
        <span className="tm-consent__client-sub">{sub}</span>
      </span>
    </div>
  );
}

function ConsentFrame({ children }: { readonly children: ReactNode }) {
  const t = useT();
  return (
    <LiveAnnouncer>
      <div className="tm-consent">
        <div className="tm-consent__card">
          <header className="tm-consent__brand">
            <span className="tm-consent__mark" aria-hidden="true" />
            <span className="tm-consent__product">TManage</span>
          </header>
          <p className="tm-consent__caption">{t(k('Consent.eyebrow'))}</p>
          <main id="tm-main" className="tm-consent__body" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
    </LiveAnnouncer>
  );
}
