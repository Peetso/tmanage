'use client';

import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listAuditEvents, MAX_AUDIT_PAGE } from '../../lib/api/admin-audit';
import type { AdminAuditEvent } from '../../lib/api/admin-audit';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface AdminAuditScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

interface AppliedFilters {
  readonly actorId: string;
  readonly entityId: string;
}

/**
 * **Audit log** — the Administration audit viewer (ADM, x115). Reads
 * `GET /v1/organizations/:orgSlug/audit/events`, which is gated on `audit.read`.
 *
 * Three decisions worth stating:
 *
 * 1. **Authorization is the API's.** The read sits behind `audit.read`; a member without it gets
 *    the ordinary 403, which `describe()` turns into the forbidden line. The screen never guesses
 *    a capability of its own and never renders blank on a refusal.
 * 2. **The projection is narrow.** The API returns id, time, actor, action, entity and a derived
 *    summary — never metadata, a correlation id or a raw request body — so there is nothing
 *    sensitive for this table to render.
 * 3. **Keyset pagination, not offset.** "Load more" carries the oldest loaded id as the cursor,
 *    so a page boundary can never repeat or skip a row; a full page (`MAX_AUDIT_PAGE`) is the
 *    only signal that more may exist.
 */
export function AdminAuditScreen({
  organizationSlug,
  organizationName,
  client,
}: AdminAuditScreenProps) {
  const api = client ?? browserApiClient();

  const [actorInput, setActorInput] = useState('');
  const [entityInput, setEntityInput] = useState('');
  const [applied, setApplied] = useState<AppliedFilters>({ actorId: '', entityId: '' });

  const events = useInfiniteQuery({
    queryKey: ['admin-audit', organizationSlug, applied.actorId, applied.entityId],
    queryFn: ({ pageParam }) =>
      listAuditEvents(api, organizationSlug, {
        limit: MAX_AUDIT_PAGE,
        ...(pageParam === undefined ? {} : { before: pageParam }),
        ...(applied.actorId === '' ? {} : { actorId: applied.actorId }),
        ...(applied.entityId === '' ? {} : { entityId: applied.entityId }),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.length === MAX_AUDIT_PAGE ? lastPage[lastPage.length - 1]?.id : undefined,
  });

  const rows = useMemo(() => events.data?.pages.flat() ?? [], [events.data]);

  function onApply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setApplied({ actorId: actorInput.trim(), entityId: entityInput.trim() });
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Audit log"
      description="Who did what in this organization, newest first."
    >
      <form
        className="tm-stack tm-stack--tight"
        onSubmit={onApply}
        aria-label="Filter the audit log"
      >
        <Field
          label="Actor ID"
          value={actorInput}
          onChange={(event) => setActorInput(event.currentTarget.value)}
          placeholder="Filter by the user who acted"
        />
        <Field
          label="Entity ID"
          value={entityInput}
          onChange={(event) => setEntityInput(event.currentTarget.value)}
          placeholder="Filter by the object acted on"
        />
        <div>
          <Button type="submit" tone="ink" size="compact">
            Apply filters
          </Button>
        </div>
      </form>

      {events.isPending ? (
        <LoadingRegion label="Loading the audit log." className="tm-stack tm-stack--tight">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {events.isError ? (
        <InlineAlert tone="danger" title="Could not load the audit log" live>
          {describe(events.error)}
        </InlineAlert>
      ) : null}

      {!events.isPending && !events.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral">No audit events match this view.</InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-audit-heading">
          <h2 id="tm-audit-heading" className="tm-eyebrow">
            Events
          </h2>
          <table className="tm-table" aria-label="Audit events, newest first">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col">Entity</th>
                <th scope="col">Summary</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((event) => (
                <AuditRow key={event.id} event={event} />
              ))}
            </tbody>
          </table>

          {events.hasNextPage ? (
            <div>
              <Button
                type="button"
                tone="outline"
                size="compact"
                onClick={() => void events.fetchNextPage()}
                disabled={events.isFetchingNextPage}
              >
                {events.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}
    </AppShell>
  );
}

function AuditRow({ event }: { event: AdminAuditEvent }) {
  return (
    <tr>
      <td className="tm-mono">{formatMoment(event.occurredAt)}</td>
      <td className="tm-mono">{event.actorId ?? 'system'}</td>
      <td className="tm-mono">{event.action}</td>
      <td className="tm-mono">
        {event.entityType}
        {event.entityId === null ? '' : ` · ${event.entityId}`}
      </td>
      <td>{event.summary}</td>
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
 * Format an ISO timestamp for display, following the browser's locale for the reason
 * `SessionsScreen` gives. An unparseable value is shown verbatim rather than as `Invalid Date`.
 */
function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
}
