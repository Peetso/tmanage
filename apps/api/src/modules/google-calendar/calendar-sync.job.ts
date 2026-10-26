import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { uuidv7 } from '@tmanage/domain';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { GoogleCalendarRepository } from './google-calendar.repository.js';

/**
 * 0237 — the calendar pull, run inside the API process (the Hostinger app is one Node process and
 * has no cron), in the `FileScanJob` shape. Every {@link CalendarSyncJobOptions.intervalMs} it
 * visits each connected calendar connection under its organization's service context and lets
 * that provider's adapter apply the changes (Google `events.list?syncToken`; slice B adds the
 * Graph `calendarView/delta` adapter). Push notifications (Google watch channels, Graph
 * subscriptions) are deferred: they expire within days and need this job to renew them anyway.
 *
 * Off unless the deployment runs background work in this process (`WORKER_INPROCESS=1`, or
 * `CALENDAR_SYNC_INPROCESS=1` for a local API), so a suite never races a pass of its own.
 */
export const CALENDAR_SYNC_JOB = Symbol.for('tmanage.CalendarSyncJob');

export interface CalendarProviderAdapter {
  /** `google` or `microsoft` — the `calendar_connections.provider` it handles. */
  readonly provider: string;
  pullConnection(context: TenantContext, connectionId: string): Promise<void>;
}

export interface CalendarSyncJobOptions {
  readonly bootDelayMs: number;
  readonly intervalMs: number;
  readonly log: (line: string) => void;
}

export const DEFAULT_CALENDAR_SYNC_JOB_OPTIONS: CalendarSyncJobOptions = {
  bootDelayMs: 30_000,
  intervalMs: 5 * 60_000,
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

  constructor(
    private readonly database: TenantDatabase,
    adapters: readonly CalendarProviderAdapter[],
    private readonly enabled: boolean,
    private readonly options: CalendarSyncJobOptions = DEFAULT_CALENDAR_SYNC_JOB_OPTIONS,
    private readonly connections: GoogleCalendarRepository = new GoogleCalendarRepository(),
  ) {
    for (const adapter of adapters) this.register(adapter);
  }

  /** Slice B registers the Microsoft adapter here. */
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
      const adapter = this.adapters.get(ref.provider);
      if (!adapter) continue;
      const context = createServiceContext({
        organizationId: ref.organizationId,
        correlationId,
        policyVersion: CALENDAR_SYNC_POLICY_VERSION,
      });
      try {
        await adapter.pullConnection(context, ref.id);
      } catch (error) {
        // One connection's failure never stops the pass for the others.
        this.options.log(`[calendar-sync] connection ${ref.id} failed: ${String(error)}`);
      }
    }
  }
}
