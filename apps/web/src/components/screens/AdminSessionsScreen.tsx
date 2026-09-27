'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listOrgSessions, revokeOrgSession } from '../../lib/api/admin-sessions';
import type { ActiveSessionView } from '../../lib/api/admin-sessions';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface AdminSessionsScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Active sessions** — the Administration session viewer + revocation (ADM, x223). Reads
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
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const [revokingId, setRevokingId] = useState<string | null>(null);

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

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Active sessions"
      description="Signed-in sessions across your organization's members. End any one of them."
    >
      {sessions.isPending ? (
        <LoadingRegion label="Loading active sessions." className="tm-stack tm-stack--tight">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {sessions.isError ? (
        <InlineAlert tone="danger" title="Could not load active sessions" live>
          {describe(sessions.error)}
        </InlineAlert>
      ) : null}

      {revoke.isError ? (
        <InlineAlert tone="danger" title="Could not end that session" live>
          {describe(revoke.error)}
        </InlineAlert>
      ) : null}

      {!sessions.isPending && !sessions.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral">No active sessions in this organization.</InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-sessions-heading">
          <h2 id="tm-sessions-heading" className="tm-eyebrow">
            Sessions
          </h2>
          <table className="tm-table" aria-label="Active sessions across the organization">
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Device</th>
                <th scope="col">Started</th>
                <th scope="col">Last seen</th>
                <th scope="col">
                  <span className="tm-visually-hidden">Actions</span>
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
                />
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </AppShell>
  );
}

function SessionRow({
  session,
  busy,
  onRevoke,
}: {
  session: ActiveSessionView;
  busy: boolean;
  onRevoke: () => void;
}) {
  return (
    <tr>
      <td>{session.memberName}</td>
      <td className="tm-mono">{session.deviceLabel ?? 'Unknown device'}</td>
      <td className="tm-mono">{formatMoment(session.createdAt)}</td>
      <td className="tm-mono">{formatMoment(session.lastSeenAt)}</td>
      <td>
        <Button type="button" tone="destructive" size="compact" onClick={onRevoke} disabled={busy}>
          {busy ? 'Ending…' : 'End session'}
        </Button>
      </td>
    </tr>
  );
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
}

/**
 * Format an ISO timestamp for display, following the browser's locale. An unparseable value is
 * shown verbatim rather than as `Invalid Date`.
 */
function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
}
