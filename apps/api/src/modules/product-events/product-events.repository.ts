import type { RowDataPacket } from 'mysql2';
import { uuidv7 } from '@tmanage/domain';
import type {
  SqlParameter,
  TenantContext,
  TenantDatabase,
} from '../../common/database/tenant-context.js';
import type { AcceptedProductEvent, ProductEventPrincipalKind } from './product-events.registry.js';
import { K_ANONYMITY_FLOOR, TIMER_EVENTS } from './product-events.registry.js';

/**
 * 55-21 — every statement over `product_events` (migration 0251).
 *
 * Two paths, the narrowest that answers each:
 *
 * - **Tenant path** for the write: one multi-row INSERT in the caller's organization, every tuple
 *   carrying the context's `organization_id` (the layer-3 guard checks each tuple).
 * - **Bootstrap path** for the Platform admin scoreboard: a read-only, audited cross-organization
 *   SELECT whose only allowlisted table is `product_events`, returning counts grouped by week,
 *   event and locale — never an organization id, an actor hash or a properties blob — and only
 *   groups with at least {@link K_ANONYMITY_FLOOR} events.
 */

export const PRODUCT_EVENTS_SCOREBOARD_REASON =
  'platform ease scoreboard (55-21): the TManage operator reads weekly product-event counts ' +
  'across organizations, aggregated with a k-anonymity floor, never content or identities';

type Row = RowDataPacket & Record<string, unknown>;

export interface ProductEventActor {
  readonly principalKind: ProductEventPrincipalKind;
  readonly actorHash: string;
}

export interface ScoreboardCountRow {
  readonly week: string;
  readonly eventName: string;
  readonly locale: string | null;
  readonly principalKind: string;
  readonly events: number;
  readonly actors: number;
  readonly organizations: number;
}

export interface ScoreboardTimerRow {
  readonly week: string;
  readonly eventName: string;
  readonly locale: string | null;
  readonly bucket: string;
  readonly events: number;
}

const WEEK = `date_format(occurred_at, '%x-W%v')`;
const COUNTS_SQL = `select ${WEEK} as week, event_name, locale, principal_kind,
    count(*) as events, count(distinct actor_hash) as actors,
    count(distinct organization_id) as organizations
  from product_events
  where occurred_at >= ?
  group by week, event_name, locale, principal_kind
  having count(*) >= ?
  order by week desc, event_name, locale, principal_kind
  limit 2000`;
const TIMER_BUCKET = `coalesce(json_unquote(json_extract(properties_json, '$.seconds_bucket')),
    json_unquote(json_extract(properties_json, '$.seconds_since_signup_bucket')))`;
const TIMERS_SQL = (names: number) => `select ${WEEK} as week, event_name, locale,
    ${TIMER_BUCKET} as bucket, count(*) as events
  from product_events
  where occurred_at >= ? and event_name in (${Array.from({ length: names }, () => '?').join(', ')})
  group by week, event_name, locale, bucket
  having count(*) >= ? and bucket is not null
  order by week desc, event_name, locale, bucket
  limit 2000`;

export class ProductEventsRepository {
  constructor(private readonly database: TenantDatabase) {}

  /** Write the accepted events of one batch, in the caller's organization. */
  async insertBatch(
    context: TenantContext,
    actor: ProductEventActor,
    events: readonly AcceptedProductEvent[],
  ): Promise<void> {
    if (events.length === 0) return;
    const params: SqlParameter[] = [];
    const tuples: string[] = [];
    for (const event of events) {
      tuples.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      params.push(
        uuidv7(),
        context.organizationId,
        event.occurredAt,
        event.eventName,
        event.eventVersion,
        actor.actorHash,
        actor.principalKind,
        event.locale,
        event.platform,
        Object.keys(event.properties).length > 0 ? JSON.stringify(event.properties) : null,
      );
    }
    await this.database.transaction(context, (runner) =>
      runner.execute(
        `insert into product_events (id, organization_id, occurred_at, event_name, event_version,
          actor_hash, principal_kind, locale, platform, properties_json) values ${tuples.join(', ')}`,
        params,
      ),
    );
  }

  /** Weekly counts and timer buckets since `since`, across organizations, floor applied. */
  async scoreboard(
    correlationId: string,
    since: Date,
  ): Promise<{ counts: ScoreboardCountRow[]; timers: ScoreboardTimerRow[] }> {
    return this.database.bootstrapRead(
      { correlationId, reason: PRODUCT_EVENTS_SCOREBOARD_REASON, tables: ['product_events'] },
      async (runner) => {
        const counts = await runner.query<Row[]>(COUNTS_SQL, [since, K_ANONYMITY_FLOOR]);
        const timers = await runner.query<Row[]>(TIMERS_SQL(TIMER_EVENTS.length), [
          since,
          ...TIMER_EVENTS,
          K_ANONYMITY_FLOOR,
        ]);
        return {
          counts: counts.map((row) => ({
            week: String(row['week']),
            eventName: String(row['event_name']),
            locale: row['locale'] == null ? null : String(row['locale']),
            principalKind: String(row['principal_kind']),
            events: Number(row['events']),
            actors: Number(row['actors']),
            organizations: Number(row['organizations']),
          })),
          timers: timers.map((row) => ({
            week: String(row['week']),
            eventName: String(row['event_name']),
            locale: row['locale'] == null ? null : String(row['locale']),
            bucket: String(row['bucket']),
            events: Number(row['events']),
          })),
        };
      },
    );
  }
}
