import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { uuidv7 } from '@tmanage/domain';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { GoogleCalendarRepository } from './google-calendar.repository.js';
import type { ConnectionRef } from './google-calendar.repository.js';
import { isCalendarRemote } from './calendar-sync-extras.js';
import type { CalendarSyncExtras } from './calendar-sync-extras.js';

/**
 * 0237 — the calendar pull, run inside the API process (the Hostinger app is one Node process and
 * has no cron), in the `FileScanJob` shape. Every {@link CalendarSyncJobOptions.intervalMs} (a
 * minute) it visits each connected calendar connection under its organization's service context
 * and lets that provider's adapter apply the changes (Google `events.list?syncToken`; slice B adds
 * the Graph `calendarView/delta` adapter).
 *
 * 53-14: after a successful pull the job hands the connection to {@link CalendarSyncExtras}
 * (push channel kept alive and renewed a day before it ends; due-date mirror kept in step), and
 * {@link CalendarSyncJob.pullSoon} lets the push webhook pull one connection at once.
 *
 * Off unless the deployment runs background work in this process (`WORKER_INPROCESS=1`, or
 * `CALENDAR_SYNC_INPROCESS=1` for a local API), so a suite never races a pass of its own.
 */
export const CALENDAR_SYNC_JOB = Symbol.for('tmanage.CalendarSyncJob');

/** What one connection's pull came to: `failed` starts (or extends) that connection's backoff. */
export type PullOutcome = 'ok' | 'failed' | 'skipped';

export interface CalendarProviderAdapter {
  /** `google` or `microsoft` — the `calendar_connections.provider` it handles. */
  readonly provider: string;
  pullConnection(context: TenantContext, connectionId: string): Promise<PullOutcome | void>;
}

export interface CalendarSyncJobOptions {
  readonly bootDelayMs: number;
  readonly intervalMs: number;
  /** The longest a failing connection waits before it is tried again. */
  readonly maxBackoffMs?: number;
  readonly log: (line: string) => void;
  readonly now?: () => number;
}

/**
 * Fix 2026-11-09: an answer given in Google or Outlook shows in TManage within about a minute
 * (was five, after a 30-second boot delay). A pull with a sync token / delta link is one cheap
 * request per connection; a connection that fails waits twice as long each time (up to
 * {@link CalendarSyncJobOptions.maxBackoffMs}), so a broken one is never hammered every minute.
 */
export const DEFAULT_CALENDAR_SYNC_JOB_OPTIONS: CalendarSyncJobOptions = {
  bootDelayMs: 10_000,
  intervalMs: 60_000,
  maxBackoffMs: 30 * 60_000,
  log: (line) => console.warn(line),
};

export const CALENDAR_SYNC_POLICY_VERSION = 'calendar-sync';
export const CALENDAR_SYNC_REASON =
  'finding every connected personal calendar in every organization, so each is pulled under ' +
  'its own organization’s service context (0237 calendar sync)';

export function calendarSyncJobEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['WORKER_INPROCESS'] === '1' || env['CALENDAR_SYNC_INPROCESS'] === '1';
}

export class CalendarSyncJob implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly adapters = new Map<string, CalendarProviderAdapter>();
  private running: Promise<void> | null = null;
  private pending: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Per connection id: consecutive failures and the earliest time it is tried again. */
  private readonly backoff = new Map<string, { failures: number; nextAt: number }>();
  /** 53-14: per connection id, a webhook-triggered pull queued or running. */
  private readonly soon = new Map<string, Promise<void>>();

  constructor(
    private readonly database: TenantDatabase,
    adapters: readonly CalendarProviderAdapter[],
    private readonly enabled: boolean,
    private readonly options: CalendarSyncJobOptions = DEFAULT_CALENDAR_SYNC_JOB_OPTIONS,
    private readonly connections: GoogleCalendarRepository = new GoogleCalendarRepository(),
    private readonly extras: CalendarSyncExtras | null = null,
  ) {
    for (const adapter of adapters) this.register(adapter);
  }

  /** Slice B: the Microsoft adapter is passed in by `GoogleCalendarModule` (or registered here). */
  register(adapter: CalendarProviderAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.pending = setTimeout(() => void this.runOnce(), this.options.bootDelayMs);
    this.pending.unref();
    this.interval = setInterval(() => void this.runOnce(), this.options.intervalMs);
    this.interval.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.pending) clearTimeout(this.pending);
    if (this.interval) clearInterval(this.interval);
    this.pending = null;
    this.interval = null;
    await this.running;
    await Promise.allSettled([...this.soon.values()]);
  }

  /** One pass; a pass already running is joined, never doubled. */
  runOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.running) {
      this.running = this.pass().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  /**
   * 53-14. A verified push notification: pull this one connection now (a pull already queued or
   * running for it is joined). Never throws; a failure waits for the next pass.
   */
  pullSoon(ref: ConnectionRef): Promise<void> {
    if (this.stopped || !this.enabled) return Promise.resolve();
    const queued = this.soon.get(ref.id);
    if (queued) return queued;
    const run = (async () => {
      await this.running?.catch(() => undefined);
      await this.visit(ref, uuidv7());
    })().finally(() => this.soon.delete(ref.id));
    this.soon.set(ref.id, run);
    return run;
  }

  private async pass(): Promise<void> {
    const correlationId = uuidv7();
    let refs;
    try {
      refs = await this.database.bootstrapRead(
        { correlationId, reason: CALENDAR_SYNC_REASON, tables: ['calendar_connections'] },
        (db) => this.connections.connectedAcrossOrganizations(db, [...this.adapters.keys()]),
      );
    } catch (error) {
      this.options.log(`[calendar-sync] listing connections failed: ${String(error)}`);
      return;
    }
    for (const ref of refs) {
      if (this.stopped) return;
      await this.visit(ref, correlationId);
    }
  }

  private async visit(ref: ConnectionRef, correlationId: string): Promise<void> {
    const adapter = this.adapters.get(ref.provider);
    if (!adapter) return;
    const context = createServiceContext({
      organizationId: ref.organizationId,
      correlationId,
      policyVersion: CALENDAR_SYNC_POLICY_VERSION,
    });
    const now = this.clock();
    const waiting = this.backoff.get(ref.id);
    if (waiting && now < waiting.nextAt) return;
    let outcome: PullOutcome | void;
    try {
      outcome = await adapter.pullConnection(context, ref.id);
    } catch (error) {
      // One connection's failure never stops the pass for the others.
      this.options.log(`[calendar-sync] connection ${ref.id} failed: ${String(error)}`);
      outcome = 'failed';
    }
    if (outcome === 'failed') {
      this.recordFailure(ref.id, now);
      return;
    }
    this.backoff.delete(ref.id);
    if (outcome === 'ok' && this.extras && isCalendarRemote(adapter)) {
      await this.extras.maintain(adapter, context, ref.id);
    }
  }

  private clock(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /** The next attempt after `failures` in a row: interval × 2^failures, capped. */
  private recordFailure(connectionId: string, now: number): void {
    const failures = (this.backoff.get(connectionId)?.failures ?? 0) + 1;
    const cap = this.options.maxBackoffMs ?? 30 * 60_000;
    const wait = Math.min(this.options.intervalMs * 2 ** failures, cap);
    this.backoff.set(connectionId, { failures, nextAt: now + wait });
  }
}
