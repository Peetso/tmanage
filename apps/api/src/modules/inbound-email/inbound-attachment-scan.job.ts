import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { describeInboundScan } from './inbound-attachment-scan.js';
import type { InboundScanReport } from './inbound-attachment-scan.js';

/**
 * R22-d (54-12a) — the inbound attachment scan pass, run inside the serving process on the
 * `file-scan-job.ts` pattern: once 5 s after boot, then every 2 minutes, and on {@link request}
 * (debounced, coalesced while a pass runs). Off unless the deployment runs background work in
 * this process (`WORKER_INPROCESS=1`, or `FILE_SCAN_INPROCESS=1` for a local API) — the same
 * switch as the file scan job (`fileScanJobEnabled`).
 *
 * The webhook controller does not call {@link request}: it would couple the ingest path to the
 * job, so the interval is the trigger and a parked attachment waits at most two minutes (stated).
 */
export const INBOUND_ATTACHMENT_SCAN_JOB = Symbol.for('tmanage.InboundAttachmentScanJob');

export interface InboundScanJobOptions {
  readonly debounceMs: number;
  readonly bootDelayMs: number;
  readonly intervalMs: number;
  readonly log: (line: string) => void;
}

export const DEFAULT_INBOUND_SCAN_JOB_OPTIONS: InboundScanJobOptions = {
  debounceMs: 1_000,
  bootDelayMs: 5_000,
  intervalMs: 2 * 60_000,
  log: (line) => console.warn(line),
};

export class InboundAttachmentScanJob implements OnApplicationBootstrap, OnModuleDestroy {
  private running: Promise<void> | null = null;
  private again = false;
  private pending: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly pass: () => Promise<InboundScanReport>,
    private readonly enabled: boolean,
    private readonly options: InboundScanJobOptions = DEFAULT_INBOUND_SCAN_JOB_OPTIONS,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.schedule(this.options.bootDelayMs);
    this.interval = setInterval(() => this.request(), this.options.intervalMs);
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

  request(): void {
    if (!this.enabled || this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.schedule(this.options.debounceMs);
  }

  /** One pass now; resolves when it (and any coalesced follow-up) is done. */
  async runNow(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.loop().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private schedule(delayMs: number): void {
    if (this.pending || this.stopped) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.runNow();
    }, delayMs);
    this.pending.unref();
  }

  private async loop(): Promise<void> {
    do {
      this.again = false;
      try {
        const report = await this.pass();
        if (report.scanned > 0) {
          this.options.log(`[inbound-scan] pass: ${describeInboundScan(report)}`);
        }
      } catch (error) {
        // An unreachable store or database stops this pass; the next tick retries.
        this.options.log(
          `[inbound-scan] pass failed: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      }
    } while (this.again && !this.stopped);
  }
}
