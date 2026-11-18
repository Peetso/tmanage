import {
  activityDefinitionFor,
  type ActivityAudienceClass,
  type ActivityKind,
  type ActivitySource,
} from '@tmanage/domain';
import type { SweepLock } from '../common/database/sweep-lock.js';

/**
 * 62-A2 (B02) — the activity projector: files each catalogued `audit_events` row under its project
 * and client in `activity_entries`, so a project's and a client's Activity tab can be read without
 * touching the chained audit table or any write path.
 *
 * ## The cursor
 *
 * One cursor per organization (`activity_projection_cursors`), in the organization's
 * `(created_at, id)` order — the order `ix_audit_events_org_time` serves. A run takes the
 * organizations whose cursor moved least recently (never-projected ones first), reads at most
 * {@link ACTIVITY_EVENTS_PER_ORGANIZATION} events after each cursor, and stops after
 * {@link ACTIVITY_EVENTS_PER_RUN} events in all: the pace that back-fills an old workspace from its
 * first event without one long statement. Only events older than {@link ACTIVITY_SETTLE_MS} are
 * read, so a row whose transaction is still open when its neighbours are read is not skipped.
 * A deleted (closing or erased) company is not projected: its audit trail is kept, its rows not.
 *
 * ## Idempotent and restart-safe
 *
 * The entries of one organization's batch and the cursor that covers them are written in one
 * transaction (`fileBatch`), and `source_audit_id` is unique (`INSERT IGNORE`). A run stopped
 * anywhere either wrote both or neither; projecting the same event twice writes one entry.
 *
 * ## What is filed
 *
 * Only actions of the domain catalogue (`activity-catalog.ts`) with result `allowed`. The store
 * resolves the event's object to its project, client and audience through the source table the
 * catalogue names (one lookup per source, `activity-projector-store.ts`); an object that no longer
 * exists, or that belongs to neither a project nor a client, is skipped — its entry would be
 * dropped at read anyway. Entries carry ids, the action and its class, never content.
 */

export const ACTIVITY_PROJECTOR_INTERVAL_MS = 60_000;
export const ACTIVITY_EVENTS_PER_ORGANIZATION = 500;
export const ACTIVITY_EVENTS_PER_RUN = 2_000;
export const ACTIVITY_ORGANIZATIONS_PER_RUN = 50;
/** Events younger than this are left for the next run (an open transaction may precede them). */
export const ACTIVITY_SETTLE_MS = 120_000;

/** Where the projector stopped in one organization; `null` fields = never projected. */
export interface ActivityCursor {
  readonly createdAt: Date;
  readonly eventId: string;
}

export interface ActivityOrganization {
  readonly organizationId: string;
  readonly cursor: ActivityCursor | null;
}

/** The fields of an audit row the projector reads: identifiers and classifications only. */
export interface ActivityAuditEvent {
  readonly id: string;
  readonly action: string;
  readonly objectId: string | null;
  readonly actorUserId: string | null;
  readonly result: string;
  readonly createdAt: Date;
  /** The row's `metadata_json.project_id`, when it is a string (membership rows are deleted). */
  readonly metadataProjectId: string | null;
}

/** Where a source row files: its project, its own client, and whether the client sees it. */
export interface ActivityPlacement {
  readonly projectId: string | null;
  readonly clientOrganizationId: string | null;
  readonly audience: Exclude<ActivityAudienceClass, 'finance'>;
}

export interface ActivityEntryRecord {
  readonly organizationId: string;
  readonly projectId: string | null;
  readonly clientOrganizationId: string | null;
  readonly objectType: ActivitySource;
  readonly objectId: string;
  readonly action: string;
  readonly kind: ActivityKind;
  readonly actorUserId: string | null;
  readonly audienceClass: ActivityAudienceClass;
  readonly occurredAt: Date;
  readonly sourceAuditId: string;
}

export interface ActivityProjectorStore {
  /** Organizations by least recently moved cursor (none first), at most `limit`. */
  organizations(limit: number): Promise<readonly ActivityOrganization[]>;
  /** Events of one organization after `cursor`, created before `settledBefore`, oldest first. */
  eventsAfter(
    organizationId: string,
    cursor: ActivityCursor | null,
    settledBefore: Date,
    limit: number,
  ): Promise<readonly ActivityAuditEvent[]>;
  /** The placement of one source row, or `null` when it no longer exists. */
  place(
    organizationId: string,
    source: ActivitySource,
    event: ActivityAuditEvent & { readonly objectId: string },
  ): Promise<ActivityPlacement | null>;
  /**
   * One transaction: `INSERT IGNORE` the entries, then move the organization's cursor to `cursor`
   * (or only touch its `updated_at` when `cursor` is `null`). Returns the entries written.
   */
  fileBatch(
    organizationId: string,
    entries: readonly ActivityEntryRecord[],
    cursor: ActivityCursor | null,
    at: Date,
  ): Promise<number>;
}

export interface ActivityProjectionResult {
  readonly organizations: number;
  readonly events: number;
  readonly filed: number;
}

/** The entry for one event, or `null` when the action is not catalogued or not a success. */
export async function projectEvent(
  store: Pick<ActivityProjectorStore, 'place'>,
  organizationId: string,
  event: ActivityAuditEvent,
): Promise<ActivityEntryRecord | null> {
  const definition = activityDefinitionFor(event.action);
  if (definition === null || event.result !== 'allowed' || event.objectId === null) return null;
  const placement = await store.place(organizationId, definition.source, {
    ...event,
    objectId: event.objectId,
  });
  if (placement === null) return null;
  if (placement.projectId === null && placement.clientOrganizationId === null) return null;
  return {
    organizationId,
    projectId: placement.projectId,
    clientOrganizationId: placement.clientOrganizationId,
    objectType: definition.source,
    objectId: event.objectId,
    action: event.action,
    kind: definition.kind,
    actorUserId: event.actorUserId,
    audienceClass: definition.finance ? 'finance' : placement.audience,
    occurredAt: event.createdAt,
    sourceAuditId: event.id,
  };
}

/** One run over at most {@link ACTIVITY_ORGANIZATIONS_PER_RUN} organizations. */
export async function runActivityProjection(deps: {
  readonly store: ActivityProjectorStore;
  readonly now: Date;
  readonly perOrganization?: number;
  readonly perRun?: number;
}): Promise<ActivityProjectionResult> {
  const { store, now } = deps;
  const perOrganization = deps.perOrganization ?? ACTIVITY_EVENTS_PER_ORGANIZATION;
  let budget = deps.perRun ?? ACTIVITY_EVENTS_PER_RUN;
  const settledBefore = new Date(now.getTime() - ACTIVITY_SETTLE_MS);
  let organizations = 0;
  let events = 0;
  let filed = 0;
  for (const organization of await store.organizations(ACTIVITY_ORGANIZATIONS_PER_RUN)) {
    if (budget <= 0) break;
    const { organizationId } = organization;
    const batch = await store.eventsAfter(
      organizationId,
      organization.cursor,
      settledBefore,
      Math.min(perOrganization, budget),
    );
    const entries: ActivityEntryRecord[] = [];
    for (const event of batch) {
      const projected = await projectEvent(store, organizationId, event);
      if (projected !== null) entries.push(projected);
    }
    const last = batch.at(-1);
    const cursor = last === undefined ? null : { createdAt: last.createdAt, eventId: last.id };
    filed += await store.fileBatch(organizationId, entries, cursor, now);
    organizations += 1;
    events += batch.length;
    budget -= batch.length;
  }
  return { organizations, events, filed };
}

/**
 * Loop mode: one run every {@link ACTIVITY_PROJECTOR_INTERVAL_MS}; stops on `signal`. With a
 * `lock` each run takes the `activity-projector` named lock, and a run another process holds is
 * skipped silently (the same shape as the person-mail and audit-anchor loops).
 */
export async function runActivityProjectorLoop(
  deps: { readonly store: ActivityProjectorStore; readonly lock?: Pick<SweepLock, 'run'> },
  signal: AbortSignal,
  onError: (error: unknown) => void = (error) =>
    console.error('[worker] activity projector failed', error),
): Promise<void> {
  const pass = () => runActivityProjection({ store: deps.store, now: new Date() });
  while (!signal.aborted) {
    try {
      if (deps.lock) await deps.lock.run('activity-projector', pass);
      else await pass();
    } catch (error) {
      onError(error);
    }
    if (signal.aborted) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ACTIVITY_PROJECTOR_INTERVAL_MS);
      signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
    });
  }
}
