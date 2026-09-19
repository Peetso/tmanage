import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { UsageCountersRepository } from './usage-counters.repository.js';

/**
 * USAGE-001 slice 4 — the storage threshold bands, `49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY`
 * §6 and `24-EVENT-CATALOG` §4's `usage.threshold_reached.v1`.
 *
 * ## What a band is
 *
 * §6's threshold table has four rows — 70% (insight), 85% (warning), 95% (persistent warning),
 * 100% (block new reservations). An organization is in exactly one band at a time; 0 is "below
 * 70%, nothing to warn about". Crossing a boundary *rising* is the moment the owner/admin should
 * be told, so it emits one `usage.threshold_reached.v1`. The band is stored on the counter row
 * (`usage_counters.threshold_band`, migration 0025) so the crossing fires once, not on every
 * later reserve inside the same band.
 *
 * ## Hysteresis (Q5, delegated: 5 percentage points)
 *
 * Without hysteresis an organization hovering at exactly 85% would emit on every reserve that
 * nudged it across and every release that nudged it back. So *falling* is stickier than rising:
 * the organization only leaves a band once its usage has dropped a full {@link
 * THRESHOLD_HYSTERESIS_PCT} points below the band's boundary. Falling below the floor then
 * rising again is allowed to emit again — that is the point of the hysteresis, not a bug.
 *
 * ## The basis (Q6, delegated: used + reserved over quota)
 *
 * The percentage is `(used + reserved) / quota` — what the reservation guard blocks on, not
 * `used` alone (what the eventual bill measures). An organization that has reserved its whole
 * quota is at 100% and blocked, whether or not those uploads have committed yet.
 *
 * {@link bandFor} and its helpers are pure and total so the table-driven unit test drives the
 * arithmetic directly; {@link UsageThresholdEvaluator} is the one seam that touches the database.
 */

/** §6's four boundaries. Ascending; 100 is the band the reservation guard already refuses at. */
export const STORAGE_THRESHOLD_BANDS = [70, 85, 95, 100] as const;

/** The band an organization is in: one boundary, or 0 for "below the first boundary". */
export type ThresholdBand = 0 | (typeof STORAGE_THRESHOLD_BANDS)[number];

/** Q5 (delegated). How far below a boundary the usage must fall before the band is left. */
export const THRESHOLD_HYSTERESIS_PCT = 5;

/** `(used + reserved) / quota`, as a percentage. A non-positive quota reads as full once anything is held. */
export function usagePercent(used: number, reserved: number, quota: number): number {
  if (quota <= 0) return used + reserved > 0 ? 100 : 0;
  return ((used + reserved) / quota) * 100;
}

/** The band `pct` alone would put an organization in, ignoring hysteresis: the highest boundary at or below it. */
function naturalBand(pct: number): ThresholdBand {
  let band: ThresholdBand = 0;
  for (const boundary of STORAGE_THRESHOLD_BANDS) {
    if (pct >= boundary) band = boundary;
  }
  return band;
}

/** The boundary one step below a band — 100→95, 95→85, 85→70, 70→0 — for the falling walk. */
function nextLowerBand(band: ThresholdBand): ThresholdBand {
  const index = STORAGE_THRESHOLD_BANDS.indexOf(band as (typeof STORAGE_THRESHOLD_BANDS)[number]);
  return index <= 0 ? 0 : (STORAGE_THRESHOLD_BANDS[index - 1] ?? 0);
}

/**
 * The band an organization at `pct` should be in given the band it is already in — the pure
 * hysteresis rule (acceptance §1). Rising (or steady) takes the natural band immediately; a
 * boundary crossed upward is a new band. Falling only leaves the current band once `pct` has
 * dropped to `currentBand - 5` or below, and then re-evaluates each lower band's own floor in
 * turn, so a plunge from 100 to 84% lands on 85 (84 is still within 85's dead-band, 80..85),
 * not on 70.
 */
export function bandFor(pct: number, currentBand: ThresholdBand): ThresholdBand {
  const natural = naturalBand(pct);
  if (natural >= currentBand) return natural;
  if (pct > currentBand - THRESHOLD_HYSTERESIS_PCT) return currentBand;
  return bandFor(pct, nextLowerBand(currentBand));
}

/** The band to emit for when moving `previous → next`, or `null` when nothing rose. */
export function crossedUpInto(previous: ThresholdBand, next: ThresholdBand): ThresholdBand | null {
  return next > previous ? next : null;
}

/**
 * The event's idempotency key: `<counterId>:<band>:<counterVersion>`. The counter version
 * advances on every move, so the same crossing redelivered carries the same key (the consumer
 * dedupes) while a re-entry after falling below the floor carries a fresh one (delivered again).
 */
export function usageThresholdIdempotencyKey(
  counterId: string,
  band: ThresholdBand,
  counterVersion: number,
): string {
  return `${counterId}:${band}:${counterVersion}`;
}

/**
 * Re-evaluate an organization's storage band inside the transaction that just moved its counter,
 * and, on a rising crossing, append one `usage.threshold_reached.v1` — plus, at 100%, one audit
 * row (§4 "audit yes at 100%"). Called from the reserve and commit paths and from the reconciler
 * on the same counter row they hold locked, so the read, the band write and the event commit
 * together: an event claiming a threshold was reached cannot exist without the move that reached
 * it, and the move cannot commit without the event.
 *
 * Idempotency is the stored band: {@link bandFor} returns the current band unchanged when nothing
 * crossed, so re-running a pass — or a reconcile tick over an unchanged counter — writes and
 * emits nothing. Only an actual rising crossing, gated by the row lock the move already holds,
 * emits, and it emits exactly once.
 */
export class UsageThresholdEvaluator {
  constructor(
    private readonly counters: UsageCountersRepository,
    private readonly outbox: OutboxEventsRepository | null,
    private readonly audit: AuditService | null,
  ) {}

  async evaluate(
    runner: TenantQueryRunner,
    context: TenantContext,
    metricKey: string,
    quotaBytes: number,
  ): Promise<void> {
    const state = await this.counters.loadThresholdState(runner, context, metricKey);
    if (state === null) return;

    const pct = usagePercent(state.used, state.reserved, quotaBytes);
    const next = bandFor(pct, state.band);
    if (next === state.band) return;

    await this.counters.setThresholdBand(runner, context, metricKey, next);

    const entered = crossedUpInto(state.band, next);
    if (entered === null) return; // Fell to a lower band: the state is re-armed, nothing is emitted.

    const sourceEventId = await this.outbox?.append(runner, context, {
      type: 'usage.threshold_reached.v1',
      aggregateId: state.id,
      payload: {
        organizationId: context.organizationId,
        band: entered,
        used: state.used,
        reserved: state.reserved,
        quota: quotaBytes,
        idempotencyKey: usageThresholdIdempotencyKey(state.id, entered, state.version),
        occurredAt: new Date().toISOString(),
      },
    });

    if (entered === 100) {
      await this.audit?.record(runner, context, {
        action: 'usage.threshold_reached',
        objectId: state.id,
        result: 'allowed',
        actorUserId: null,
        metadata: {
          metric_key: metricKey,
          band: entered,
          used_value: state.used,
          reserved_value: state.reserved,
          quota_bytes: quotaBytes,
          source_event_id: sourceEventId ?? null,
        },
      });
    }
  }
}
