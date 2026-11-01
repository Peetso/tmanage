'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { shortDevice, sinceLabel } from '../admin/format';
import { apiBaseUrl, browserApiClient } from '../../lib/api/browser-client';
import {
  adminSessionTrailCsvUrl,
  listOrgSessions,
  revokeOrgSession,
} from '../../lib/api/admin-sessions';
import {
  IntelDeviceCell,
  IntelLocationCell,
  IntelNetworkCell,
  SessionIntelDrawer,
} from '../security/SessionIntelCards';
import { SignalPill } from '../security/SignalPill';
import type { ActiveSessionView } from '../../lib/api/admin-sessions';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { appLocale } from '../../lib/i18n/app-locale';

export interface AdminSessionsScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Active sessions** — the Administration session viewer + revocation (ADM-08's session card,
 * x223), drawn as ADM-08's "Active sessions · N / Last seen" table card at full width. Reads
 * `GET .../admin/sessions` and posts to `.../admin/sessions/:sessionId/revoke`, both gated on
 * `org.manage`.
 *
 * Three decisions worth stating:
 *
 * 1. **Authorization is the API's.** Both routes sit behind `org.manage`; a member without it
 *    gets the ordinary 403, which `describe()` turns into the forbidden line. The screen never
 *    guesses a capability of its own.
 * 2. **The projection is metadata only.** The API returns the member, the device label and the
 *    start/last-seen times — never a token or refresh material — so there is nothing sensitive
 *    for this table to render.
 * 3. **Revoke is a soft-close, and idempotent.** Ending a session removes it from the live list
 *    on the next refetch; a second click on a row mid-flight is harmless because the API treats
 *    a re-revoke as a no-op.
 */
export function AdminSessionsScreen({
  organizationSlug,
  organizationName,
  client,
}: AdminSessionsScreenProps) {
  const describe = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const sessions = useQuery({
    queryKey: ['admin-sessions', organizationSlug],
    queryFn: () => listOrgSessions(api, organizationSlug),
  });

  const revoke = useMutation({
    mutationFn: (sessionId: string) => revokeOrgSession(api, organizationSlug, sessionId),
    onMutate: (sessionId: string) => setRevokingId(sessionId),
    onSettled: async () => {
      setRevokingId(null);
      await queryClient.invalidateQueries({ queryKey: ['admin-sessions', organizationSlug] });
    },
  });

  const rows = sessions.data ?? [];
  const opened = rows.find((row) => row.sessionId === openId) ?? null;

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="sessions"
      crumbs={[t('AdminSessionsScreen.crumbSecurity'), t('AdminSessionsScreen.crumbSessions')]}
      title={t('AdminSessionsScreen.title')}
      {...(sessions.isSuccess
        ? {
            titleMeta: `${rows.length} ${rows.length === 1 ? t('AdminSessionsScreen.activeSessionSingular') : t('AdminSessionsScreen.activeSessionPlural')}`,
          }
        : {})}
    >
      {sessions.isPending ? (
        <LoadingRegion
          label={t('AdminSessionsScreen.loading')}
          className="tm-stack tm-stack--tight"
        >
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {sessions.isError ? (
        <InlineAlert tone="danger" title={t('AdminSessionsScreen.loadError')} live>
          {describe(sessions.error)}
        </InlineAlert>
      ) : null}

      {revoke.isError ? (
        <InlineAlert tone="danger" title={t('AdminSessionsScreen.revokeError')} live>
          {describe(revoke.error)}
        </InlineAlert>
      ) : null}

      {!sessions.isPending && !sessions.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral">{t('AdminSessionsScreen.empty')}</InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <section className="tm-cc-card tm-cc-card--flush" aria-labelledby="tm-sessions-heading">
          <h2 id="tm-sessions-heading" className="tm-visually-hidden">
            {t('AdminSessionsScreen.sessionsHeading')}
          </h2>
          <table className="tm-table tm-cc-table" aria-label={t('AdminSessionsScreen.tableLabel')}>
            <thead>
              <tr>
                <th scope="col">
                  {t('AdminSessionsScreen.colActiveSessionsPrefix')} {rows.length}
                </th>
                <th scope="col">{t('SessionIntel.colDevice')}</th>
                <th scope="col">{t('SessionIntel.colLocation')}</th>
                <th scope="col">{t('SessionIntel.colNetwork')}</th>
                <th scope="col">{t('SessionIntel.colSignal')}</th>
                <th scope="col">{t('AdminSessionsScreen.colSignedIn')}</th>
                <th scope="col">{t('AdminSessionsScreen.colLastSeen')}</th>
                <th scope="col">
                  <span className="tm-visually-hidden">{t('AdminSessionsScreen.colActions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((session) => (
                <SessionRow
                  key={session.sessionId}
                  session={session}
                  busy={revoke.isPending && revokingId === session.sessionId}
                  onRevoke={() => revoke.mutate(session.sessionId)}
                  onOpen={() => setOpenId(session.sessionId)}
                />
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {opened ? (
        <SessionIntelDrawer
          title={`${t('SessionIntel.sessionWord')} · ${opened.memberName}`}
          subtitle={`${shortDevice(opened.deviceLabel)} · ${t('SessionIntel.started')} ${formatMoment(opened.createdAt)}`}
          intel={opened.intel}
          rawUserAgent={opened.deviceLabel}
          csvUrl={adminSessionTrailCsvUrl(apiBaseUrl(), organizationSlug, opened.sessionId)}
          csvFileName={`session-trail-${opened.sessionId}.csv`}
          printHref={`/${encodeURIComponent(organizationSlug)}/admin/sessions/${encodeURIComponent(opened.sessionId)}/trail`}
          onClose={() => setOpenId(null)}
        >
          <Button
            type="button"
            tone="destructive"
            disabled={revoke.isPending}
            onClick={() => {
              revoke.mutate(opened.sessionId);
              setOpenId(null);
            }}
          >
            {t('AdminSessionsScreen.endSession')}
          </Button>
        </SessionIntelDrawer>
      ) : null}
    </ControlCenterShell>
  );
}

function SessionRow({
  session,
  busy,
  onRevoke,
  onOpen,
}: {
  session: ActiveSessionView;
  busy: boolean;
  onRevoke: () => void;
  onOpen: () => void;
}) {
  const t = useT();
  return (
    <tr>
      <td>
        <button type="button" className="tm-intel-open" onClick={onOpen}>
          <span className="tm-cc-cell-title">{session.memberName}</span>
        </button>
      </td>
      <td>
        <IntelDeviceCell intel={session.intel} fallback={shortDevice(session.deviceLabel)} />
      </td>
      <td>
        <IntelLocationCell intel={session.intel} ip={session.intel?.ipLast ?? null} />
      </td>
      <td>
        <IntelNetworkCell intel={session.intel} />
      </td>
      <td>
        <SignalPill automation={session.intel?.automation} />
      </td>
      <td>
        <span className="tm-cc-cell-sub">{formatMoment(session.createdAt)}</span>
      </td>
      <td>
        <span className="tm-cc-cell-mono" title={formatMoment(session.lastSeenAt)}>
          {sinceLabel(session.lastSeenAt)}
        </span>
      </td>
      <td className="tm-cc-end">
        <Button type="button" tone="outline" size="compact" onClick={onRevoke} disabled={busy}>
          {busy ? t('AdminSessionsScreen.ending') : t('AdminSessionsScreen.endSession')}
        </Button>
      </td>
    </tr>
  );
}

/**
 * Format an ISO timestamp for display, following the browser's locale. An unparseable value is
 * shown verbatim rather than as `Invalid Date`.
 */
function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(appLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
    at,
  );
}
