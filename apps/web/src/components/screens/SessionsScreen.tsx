'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, Skeleton, StatusDot } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { BackendPending } from './BackendPending';
import { browserApiClient } from '../../lib/api/browser-client';
import { listDevices, signOut } from '../../lib/api/session';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface SessionsScreenProps {
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
  /** Called after a successful sign-out, so the page can navigate. */
  onSignedOut?: () => void;
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
export function SessionsScreen({ client, onSignedOut }: SessionsScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const devices = useQuery({
    queryKey: ['sessions', 'devices'],
    queryFn: () => listDevices(api),
  });

  const endSession = useMutation({
    mutationFn: () => signOut(api),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['sessions'] });
      onSignedOut?.();
    },
  });

  return (
    <IdentityShell screenId="ID-05" eyebrow="Sessions and devices">
      <div className="tm-stack tm-stack--tight">
        <h1 className="tm-identity__title">Where you are signed in</h1>
        <p className="tm-prose">
          Every active session for your account. Signing out ends this one everywhere it is held.
        </p>
      </div>

      {devices.isPending ? (
        <div className="tm-stack tm-stack--tight" aria-busy="true" aria-live="polite">
          <span className="tm-visually-hidden">Loading your sessions.</span>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </div>
      ) : null}

      {devices.isError ? (
        <InlineAlert tone="danger" title="Could not load your sessions" live>
          {describe(devices.error)}
        </InlineAlert>
      ) : null}

      {devices.isSuccess ? (
        devices.data.length === 0 ? (
          <InlineAlert tone="neutral">No active sessions.</InlineAlert>
        ) : (
          <ul className="tm-stack tm-list">
            {devices.data.map((session) => (
              <li key={session.id} className="tm-panel tm-stack tm-stack--tight">
                <p className="tm-session__agent">{session.userAgent ?? 'Unknown device'}</p>
                <p className="tm-prose tm-mono">
                  Started {formatMoment(session.createdAt)} · Expires{' '}
                  {formatMoment(session.expiresAt)}
                  {session.rotatedAt === null
                    ? ''
                    : ` · Last refreshed ${formatMoment(session.rotatedAt)}`}
                </p>
                <div className="tm-row">
                  <StatusDot tone="neutral">Active</StatusDot>
                  <Button tone="outline" size="compact" disabled>
                    Revoke
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )
      ) : null}

      <div className="tm-row">
        <Button
          tone="destructive"
          size="accessible"
          loading={endSession.isPending}
          loadingLabel="Signing out"
          onClick={() => endSession.mutate()}
        >
          Sign out of this session
        </Button>
      </div>

      {endSession.isError ? (
        <InlineAlert tone="danger" title="Sign-out failed" live>
          {describe(endSession.error)}
        </InlineAlert>
      ) : null}

      <BackendPending ticket="ID-002 · ADMIN-002">
        Revoking one other session, recovery codes, and the security-event receipt are not built.
        Revoking a named session has no route yet; the audit read model that would show the receipt
        is not written.
      </BackendPending>
    </IdentityShell>
  );
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
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
