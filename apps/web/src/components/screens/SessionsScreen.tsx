'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { useT } from '../../lib/i18n/use-t';
import { browserApiClient } from '../../lib/api/browser-client';
import { listDevices, signOut } from '../../lib/api/session';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { authBoundary, type AuthBoundary } from '../../lib/auth-boundary';
import '../../styles/screens/identity.css';

export interface SessionsScreenProps {
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
  /** Called after a successful sign-out, so the page can navigate. */
  onSignedOut?: () => void;
  /** Injected in tests. Defaults to the application's boundary. */
  boundary?: AuthBoundary;
}

/**
 * **ID-05 Session and recovery** — the sessions half.
 *
 * `22-SCREEN-BY-SCREEN` §3: "Active devices, last activity, revoke one/all, recovery codes,
 * security event receipt."
 *
 * This is the one screen in WEB-001 whose data is real. `GET /v1/sessions/current/devices`
 * exists, is authenticated, and returns a projection that `sessions.repository.ts` documents
 * as carrying "no token hash of any kind". `DELETE /v1/sessions/current` exists too, so
 * "sign out" genuinely signs out.
 *
 * Three of the five things `22` §3 asks for do not exist and are marked rather than faked:
 *
 * - **Revoke one.** There is no per-session revoke route; `SessionService.revoke()` is called
 *   with the *current* session id by the sign-out controller. Revoking a named other session
 *   is a route that has not been written.
 * - **Recovery codes.** ID-002.
 * - **Security event receipt.** AUD-001 writes audit rows but there is no read endpoint, and
 *   `audit_events` has no column that would let one be scoped to a person across
 *   organizations — see the AUD-001 gaps in `docs/implementation-status.md`.
 *
 * The list also cannot mark "this device": the API's `SessionSummary` has five fields and
 * `current` is not among them. Guessing from the user agent would be wrong the moment two
 * tabs of the same browser hold two sessions, so it is left unmarked.
 */
export function SessionsScreen({
  client,
  onSignedOut,
  boundary = authBoundary,
}: SessionsScreenProps) {
  const describe = useDescribeApiError();
  const t = useT();
  const api = client ?? browserApiClient();

  const devices = useQuery({
    queryKey: ['sessions', 'devices'],
    queryFn: () => listDevices(api),
  });

  const endSession = useMutation({
    mutationFn: () => signOut(api),
    onSuccess: () => {
      // Not `invalidateQueries(['sessions'])`. Review finding D01: the root `QueryClient`
      // outlives a client-side navigation, and every other cached query is keyed by
      // organization, not by person, so the next person to sign in on this browser was shown
      // this person's rows. The boundary clears everything, in every tab, before navigation.
      boundary.announce('signed-out');
      onSignedOut?.();
    },
  });

  return (
    <IdentityShell screenId="ID-06" eyebrow={t('SessionsScreen.eyebrow')}>
      <div className="tm-id-bare tm-id-sessions tm-stack">
        <div className="tm-id-sessions__head">
          <h1 className="tm-identity__title">{t('SessionsScreen.heading')}</h1>
          <Button
            tone="destructive"
            size="accessible"
            loading={endSession.isPending}
            loadingLabel={t('SessionsScreen.signingOut')}
            onClick={() => endSession.mutate()}
          >
            {t('SessionsScreen.signOut')}
          </Button>
        </div>

        {endSession.isError ? (
          <InlineAlert tone="danger" title={t('SessionsScreen.signOutFailed')} live>
            {describe(endSession.error)}
          </InlineAlert>
        ) : null}

        {devices.isPending ? (
          <LoadingRegion label={t('SessionsScreen.loading')} className="tm-stack tm-stack--tight">
            <Skeleton height="56px" />
            <Skeleton height="56px" />
            <Skeleton height="56px" />
          </LoadingRegion>
        ) : null}

        {devices.isError ? (
          <InlineAlert tone="danger" title={t('SessionsScreen.loadError')} live>
            {describe(devices.error)}
          </InlineAlert>
        ) : null}

        {devices.isSuccess ? (
          devices.data.length === 0 ? (
            <InlineAlert tone="neutral">{t('SessionsScreen.noActiveSessions')}</InlineAlert>
          ) : (
            <ul className="tm-id-session-list">
              {devices.data.map((session) => (
                <li key={session.id} className="tm-id-session">
                  <span className="tm-id-session__glyph" aria-hidden="true">
                    {deviceGlyph(session.userAgent)}
                  </span>
                  <div className="tm-id-session__text">
                    <p className="tm-id-session__agent" title={session.userAgent ?? undefined}>
                      {session.userAgent ?? t('SessionsScreen.unknownDevice')}
                    </p>
                    <p className="tm-id-session__meta">
                      {t('SessionsScreen.started')} {formatMoment(session.createdAt)}{' '}
                      {t('SessionsScreen.expiresWord')} {formatMoment(session.expiresAt)}
                      {session.rotatedAt === null
                        ? ''
                        : ` ${t('SessionsScreen.lastRefreshedWord')} ${formatMoment(session.rotatedAt)}`}
                    </p>
                  </div>
                  {/* There is no per-session revoke route yet, so the control is shown disabled. */}
                  <Button
                    tone="outline"
                    size="compact"
                    disabled
                    title={t('SessionsScreen.revokeUnavailable')}
                  >
                    {t('SessionsScreen.revoke')}
                  </Button>
                </li>
              ))}
            </ul>
          )
        ) : null}

        <div className="tm-id-cards">
          <section className="tm-id-card" aria-labelledby="tm-sessions-passkeys">
            <h2 id="tm-sessions-passkeys" className="tm-id-mono">
              {t('SessionsScreen.passkeysHeading')}
            </h2>
            <p className="tm-id-card__body">{t('SessionsScreen.passkeysBody')}</p>
          </section>
          <section className="tm-id-card" aria-labelledby="tm-sessions-recovery">
            <h2 id="tm-sessions-recovery" className="tm-id-mono">
              {t('SessionsScreen.recoveryHeading')}
            </h2>
            <p className="tm-id-card__body">{t('SessionsScreen.recoveryBody')}</p>
          </section>
        </div>
      </div>
    </IdentityShell>
  );
}

/** A small glyph for the row: a phone for a mobile browser, a window otherwise. */
function deviceGlyph(userAgent: string | null): string {
  if (userAgent === null) return '?';
  return /iphone|android|mobile/i.test(userAgent) ? '▦' : '▤';
}

/**
 * Format an ISO timestamp for display.
 *
 * `Intl.DateTimeFormat` with no explicit locale, so it follows the browser. A hard-coded
 * `en-GB` would be wrong for the Arabic locale `19-SEED-DATA-AND-COPY` requires, and a
 * hand-rolled format would be wrong everywhere. An unparseable value is shown verbatim
 * rather than as `Invalid Date`.
 */
function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
}
