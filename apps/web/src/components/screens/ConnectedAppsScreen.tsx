'use client';

import Link from 'next/link';
import { useId, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { ConnectAppsCards } from './ConnectAppsCards';
import { ConnectorDirectory } from './ConnectorDirectory';
import { FigmaConnectCard } from './FigmaConnectCard';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  getConnectedApps,
  revokeConnectedApp,
  setWorkspaceAiAccess,
} from '../../lib/api/connected-apps';
import type { ConnectedApp, ConnectedAppsView } from '../../lib/api/connected-apps';
import type { ApiClient } from '../../lib/api/client';
import { fillTemplate } from '../../lib/ai-approval-presentation';
import {
  appMonograms,
  formatConnectedDate,
  formatLastUsed,
  scopeLabelKey,
} from '../../lib/connected-apps-presentation';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useOrganizationName, useOrganizationRole } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';
import '../../styles/screens/connected-apps.css';

/** The built-in connection cards, which a built-in connector's "Manage" scrolls to. */
const CONNECT_CARDS_ID = 'connect-apps';

export interface ConnectedAppsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
  /** The clock for "Last used …"; injected by stories and tests. */
  now?: Date;
}

/**
 * **Control center > Connected apps** (Figma S0-2: EN 366:1214, AR 366:1352; empty EN 366:1490,
 * AR 366:1499). The AI apps connected to this workspace, each with its access, its workspace,
 * when it was connected and last used, and Revoke. An owner also sees everyone's apps and the
 * "Allow AI apps in this workspace" switch. Arabic is the same screen through the catalog, mirrored
 * by the document direction; app names stay as the apps spell them.
 */
export function ConnectedAppsScreen({
  organizationSlug,
  organizationName: passedOrganizationName,
  client,
  now,
}: ConnectedAppsScreenProps) {
  const organizationName = useOrganizationName(organizationSlug, passedOrganizationName);
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const t = useT();
  const locale = useActiveLocale();
  const queryKey = ['connected-apps', organizationSlug];
  // 54-01: the connector directory is owner/admin only (`org.manage`), as its routes are.
  const role = useOrganizationRole(organizationSlug);
  const managesCompany =
    role.known &&
    (['owner', 'org_admin', 'admin'].includes(role.role ?? '') ||
      (role.capabilities ?? []).includes('org.manage'));

  const view = useQuery({ queryKey, queryFn: () => getConnectedApps(api, organizationSlug) });

  const revoke = useMutation({
    mutationFn: (grantId: string) => revokeConnectedApp(api, organizationSlug, grantId),
    onSuccess: (_result, grantId) =>
      queries.setQueryData<ConnectedAppsView>(queryKey, (current) =>
        current ? { ...current, apps: current.apps.filter((app) => app.id !== grantId) } : current,
      ),
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setWorkspaceAiAccess(api, organizationSlug, enabled),
    onSuccess: ({ aiAccessEnabled }) =>
      queries.setQueryData<ConnectedAppsView>(queryKey, (current) =>
        current ? { ...current, aiAccessEnabled } : current,
      ),
  });

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="connected-apps"
      crumbs={[t('ControlCenterShell.connectedApps')]}
      title={t('ConnectedApps.title')}
      description={t('ConnectedApps.description')}
    >
      <div className="tm-connected">
        {/* R37: the one-click app cards (calendars, company storage) come first. */}
        <div id={CONNECT_CARDS_ID}>
          <ConnectAppsCards api={api} organizationSlug={organizationSlug} />
        </div>
        {/* 54-01 Connected apps v2: every registered connector with its install state. */}
        {managesCompany ? (
          <ConnectorDirectory
            api={api}
            organizationSlug={organizationSlug}
            builtInAnchor={CONNECT_CARDS_ID}
          />
        ) : null}
        {view.isPending ? (
          <LoadingRegion label={t('ConnectedApps.loading')}>
            <Skeleton height="320px" radius="var(--r-card)" />
          </LoadingRegion>
        ) : view.isError ? (
          <InlineAlert tone="danger" title={t('ConnectedApps.loadError')}>
            {null}
          </InlineAlert>
        ) : (
          <>
            {/* C19: "Owner view · name" is the Control Center eyebrow above the title; a second
                caption here repeated it. */}
            {revoke.isError || toggle.isError ? (
              <InlineAlert tone="danger" title={t('ConnectedApps.saveError')} live>
                {null}
              </InlineAlert>
            ) : null}
            {view.data.owner ? (
              <OwnerControl
                enabled={view.data.aiAccessEnabled}
                workspace={organizationName}
                busy={toggle.isPending}
                onChange={(enabled) => toggle.mutate(enabled)}
              />
            ) : null}
            {view.data.apps.length === 0 ? (
              <EmptyState organizationSlug={organizationSlug} />
            ) : (
              <AppList
                apps={view.data.apps}
                workspace={organizationName}
                locale={locale}
                now={now ?? new Date()}
                revokingId={revoke.isPending ? revoke.variables : undefined}
                onRevoke={(id) => revoke.mutate(id)}
              />
            )}
          </>
        )}
        <h2 className="tm-connected__caption">{t('Figma.connect.section')}</h2>
        <div id="tm-figma-connect">
          <FigmaConnectCard api={api} organizationSlug={organizationSlug} />
        </div>
      </div>
    </ControlCenterShell>
  );
}

function OwnerControl({
  enabled,
  workspace,
  busy,
  onChange,
}: {
  enabled: boolean;
  workspace: string;
  busy: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const t = useT();
  const id = useId();
  return (
    <section className="tm-connected__owner" aria-labelledby={`${id}-title`}>
      <div className="tm-connected__owner-text">
        <p className="tm-connected__owner-eyebrow">{t('ConnectedApps.ownerControl')}</p>
        <label className="tm-connected__owner-title" id={`${id}-title`} htmlFor={`${id}-switch`}>
          {t('ConnectedApps.allowTitle')}
        </label>
        <p className="tm-connected__owner-hint" id={`${id}-hint`}>
          {fillTemplate(t('ConnectedApps.allowHint'), { workspace })}
        </p>
      </div>
      <input
        id={`${id}-switch`}
        type="checkbox"
        role="switch"
        className="tm-connected__switch"
        checked={enabled}
        aria-describedby={`${id}-hint`}
        aria-busy={busy}
        onChange={(event) => {
          if (!busy) onChange(event.currentTarget.checked);
        }}
      />
    </section>
  );
}

function AppList({
  apps,
  workspace,
  locale,
  now,
  revokingId,
  onRevoke,
}: {
  apps: readonly ConnectedApp[];
  workspace: string;
  locale: string;
  now: Date;
  revokingId: string | undefined;
  onRevoke: (id: string) => void;
}) {
  const t = useT();
  const monograms = useMemo(() => appMonograms(apps.map((app) => app.clientName)), [apps]);
  return (
    <>
      <p className="tm-connected__caption">
        {fillTemplate(t('ConnectedApps.connectedCount'), { count: String(apps.length) })}
      </p>
      <ul className="tm-connected__list">
        {apps.map((app, index) => (
          <li key={app.id} className="tm-connected__app">
            <div className="tm-connected__app-row">
              <div className="tm-connected__app-identity">
                <span className="tm-connected__monogram" aria-hidden="true" dir="ltr">
                  {monograms[index]}
                </span>
                <div className="tm-connected__app-text">
                  <div className="tm-connected__app-name-row">
                    <h2 className="tm-connected__app-name" dir="ltr">
                      {app.clientName}
                    </h2>
                    <span
                      className={
                        app.verified
                          ? 'tm-connected__badge tm-connected__badge--verified'
                          : 'tm-connected__badge tm-connected__badge--unverified'
                      }
                    >
                      {t(app.verified ? 'ConnectedApps.verified' : 'ConnectedApps.unverified')}
                    </span>
                  </div>
                  <ul className="tm-connected__scopes" aria-label={t('ConnectedApps.scopesLabel')}>
                    {app.scopes.map((scope) => {
                      const key = scopeLabelKey(scope);
                      return key ? (
                        <li key={scope} className="tm-connected__scope">
                          {t(key)}
                        </li>
                      ) : null;
                    })}
                  </ul>
                </div>
              </div>
              <Button
                tone="outline"
                className="tm-connected__revoke"
                loading={revokingId === app.id}
                loadingLabel={t('ConnectedApps.revoking')}
                aria-label={fillTemplate(t('ConnectedApps.revokeLabel'), { app: app.clientName })}
                onClick={() => onRevoke(app.id)}
              >
                {t('ConnectedApps.revoke')}
              </Button>
            </div>
            <p className="tm-connected__meta">
              <span dir="ltr">{workspace}</span>
              <span aria-hidden="true">·</span>
              <span>
                {fillTemplate(t('ConnectedApps.connectedOn'), {
                  date: formatConnectedDate(app.connectedAt, locale),
                })}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {app.lastUsedAt === null
                  ? t('ConnectedApps.notUsed')
                  : fillTemplate(t('ConnectedApps.lastUsed'), {
                      when: formatLastUsed(app.lastUsedAt, now, locale),
                    })}
              </span>
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}

function EmptyState({ organizationSlug }: { organizationSlug: string }) {
  const t = useT();
  return (
    <section className="tm-connected__empty">
      <span className="tm-connected__empty-mark" aria-hidden="true">
        +
      </span>
      <h2 className="tm-connected__empty-title">{t('ConnectedApps.emptyTitle')}</h2>
      <p className="tm-connected__empty-body">{t('ConnectedApps.emptyBody')}</p>
      <Link href={`/${organizationSlug}/help/connect-ai`} className="tm-connected__connect">
        {t('ConnectedApps.connectAi')}
      </Link>
    </section>
  );
}
