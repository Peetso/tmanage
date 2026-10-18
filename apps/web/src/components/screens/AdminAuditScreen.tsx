'use client';

import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { apiBaseUrl, browserApiClient } from '../../lib/api/browser-client';
import { auditExportUrl, listAuditEvents, MAX_AUDIT_PAGE } from '../../lib/api/admin-audit';
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
 * **Audit log** — ADM-09 "Immutable event stream" (ADM, x115). Reads
 * `GET /v1/organizations/:orgSlug/audit/events`, which is gated on `audit.read`.
 *
 * The frame is a table card of events (when · who/what changed · event · class) beside an aside
 * that shows the chosen event's fields; the viewer's filters live in that aside.
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
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
  const selected = rows.find((event) => event.id === selectedId) ?? null;

  function onApply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSelectedId(null);
    setApplied({ actorId: actorInput.trim(), entityId: entityInput.trim() });
  }

  const title = events.isSuccess
    ? `${rows.length}${events.hasNextPage ? '+' : ''} ${rows.length === 1 ? 'event' : 'events'}`
    : 'Audit log';

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="audit"
      crumbs={['Audit log']}
      title={title}
      {...(events.isSuccess && rows.length > 0 ? { titleMeta: classBreakdown(rows) } : {})}
      actions={
        // ADM-09 export (x118). A plain download link, not a fetch: the browser requests the CSV
        // with the session cookie and the API's `Content-Disposition: attachment` saves it, so no
        // bytes are proxied through the app. It is gated on `audit.export` — a stronger grant than
        // the `audit.read` this screen reads with — so a caller without it receives the API's
        // refusal. The href carries the applied filters, so an export matches what is on screen.
        <a
          className="tm-button tm-button--ink tm-button--compact"
          href={auditExportUrl(apiBaseUrl(), organizationSlug, {
            ...(applied.actorId === '' ? {} : { actorId: applied.actorId }),
            ...(applied.entityId === '' ? {} : { entityId: applied.entityId }),
          })}
          download="audit-events.csv"
        >
          Export CSV
        </a>
      }
    >
      <div className="tm-cc-split tm-cc-split--stretch">
        <div className="tm-cc-column">
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
            <section
              className="tm-cc-card tm-cc-card--flush tm-cc-card--fill"
              aria-labelledby="tm-audit-heading"
            >
              <h2 id="tm-audit-heading" className="tm-visually-hidden">
                Events
              </h2>
              <div className="tm-table-scroll tm-cc-table-plain">
                <table className="tm-table tm-cc-table" aria-label="Audit events, newest first">
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Who · what changed</th>
                      <th scope="col">Event</th>
                      <th scope="col" className="tm-cc-end">
                        Class
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((event) => (
                      <AuditRow
                        key={event.id}
                        event={event}
                        selected={event.id === selectedId}
                        onSelect={() => setSelectedId(event.id)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              {events.hasNextPage ? (
                <div className="tm-cc-table-foot">
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
        </div>

        <aside className="tm-cc-card" aria-label="Event details and filters">
          {selected ? (
            <>
              <p className="tm-cc-eyebrow">Event {shortId(selected.id)}</p>
              <h2 className="tm-cc-card__title">{selected.summary}</h2>
              <dl className="tm-cc-dl">
                <dt>Actor</dt>
                <dd>{selected.actorId ?? 'system'}</dd>
                <dt>Action</dt>
                <dd>{selected.action}</dd>
                <dt>Target</dt>
                <dd>
                  {selected.entityType}
                  {selected.entityId === null ? '' : ` · ${selected.entityId}`}
                </dd>
                <dt>When</dt>
                <dd>{formatMoment(selected.occurredAt)}</dd>
                <dt>Id</dt>
                <dd className="tm-mono">{selected.id}</dd>
              </dl>
              <hr className="tm-cc-rule" />
            </>
          ) : (
            <>
              <p className="tm-cc-eyebrow">Choose an event</p>
              <h2 className="tm-cc-card__title">Every change, in order</h2>
            </>
          )}
          <p className="tm-cc-card__body">
            Audit entries cannot be edited or deleted, including by an owner.
          </p>

          <form
            className="tm-stack tm-stack--tight tm-cc-card__actions--end"
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
            <div className="tm-row tm-row--wrap">
              <Button type="submit" tone="outline" size="compact">
                Apply filters
              </Button>
            </div>
          </form>
        </aside>
      </div>
    </ControlCenterShell>
  );
}

function AuditRow({
  event,
  selected,
  onSelect,
}: {
  event: AdminAuditEvent;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <tr data-selected={selected ? 'true' : undefined}>
      <td>
        <span className="tm-cc-cell-mono">{formatWhen(event.occurredAt)}</span>
      </td>
      <td>
        <button
          type="button"
          className="tm-cc-row-button tm-cc-cell-title"
          aria-pressed={selected}
          onClick={onSelect}
        >
          {event.summary}
        </button>
        <span className="tm-cc-cell-sub">
          <span>{event.action}</span> ·{' '}
          <span title={event.actorId ?? undefined}>
            {event.actorId === null ? 'system' : `by ${shortId(event.actorId)}`}
          </span>
        </span>
      </td>
      <td>
        <span className="tm-cc-cell-mono">{shortId(event.id)}</span>
      </td>
      <td className="tm-cc-end">
        <span className={classPill(event.entityType)}>{humanise(event.entityType)}</span>
      </td>
    </tr>
  );
}

/** "41 policy · 108 access · 463 content" — the loaded rows counted by entity type. */
function classBreakdown(rows: readonly AdminAuditEvent[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.entityType, (counts.get(row.entityType) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([type, count]) => `${count} ${humanise(type)}`)
    .join(' · ');
}

function classPill(entityType: string): string {
  if (/client|portal/i.test(entityType)) return 'tm-cc-pill tm-cc-pill--client';
  if (/policy|role|security|membership|setting/i.test(entityType)) return 'tm-cc-pill';
  return 'tm-cc-pill tm-cc-pill--muted';
}

/** `work_item` → `work item`: the class pill and the breakdown read as words. */
function humanise(value: string): string {
  return value.replace(/[_.]+/g, ' ');
}

/** The trailing part of an id — enough to tell rows apart, as the frame's "EV·9C41". */
function shortId(id: string): string {
  const tail = id.replace(/-/g, '').slice(-6);
  return id.length <= 10 ? id : `…${tail}`;
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
}

/** "Today 09:40", "Yest 16:12", "13 Aug 10:04" — ADM-09's timestamp column. */
function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (at.toDateString() === today.toDateString()) return `Today ${time}`;
  if (at.toDateString() === yesterday.toDateString()) return `Yest ${time}`;
  return `${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`;
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
