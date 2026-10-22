import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { describeScan } from './file-scanner.js';
import type { FileScanner } from './file-scanner.js';
import { describeVerification } from './file-verifier.js';
import type { FileVerifier } from './file-verifier.js';
import { describeFailure } from './upload-session-sweeper.js';

/**
 * CQ-09 (audit gap 8) — the scan job, run inside the process that serves the uploads.
 *
 * Root cause of "the scanner never runs": the verification and scan passes only ever ran from
 * `verify:once`, which assumes an external cron. The single-process Hostinger app has no cron,
 * so every upload stayed `verifying` forever and the download gate refused it. This job runs
 * the same two passes (`verify.ts`'s order: verify, then scan) in-process:
 *
 *  - {@link request} — called by `FilesService` after an upload commits; debounced, and
 *    coalesced while a pass is already running (one more pass follows it);
 *  - once shortly after boot, for whatever an earlier process left behind;
 *  - every {@link FileScanJobOptions.intervalMs}, for stale scan claims and retries.
 *
 * Off unless the deployment runs background work in this process (`WORKER_INPROCESS=1`, the
 * Hostinger switch, or `FILE_SCAN_INPROCESS=1` for a local API): a suite or the `verify:once`
 * CLI composes the same module and must not race a pass of its own.
 */
export const FILE_SCAN_JOB = Symbol.for('tmanage.FileScanJob');

export interface FileScanJobOptions {
  readonly debounceMs: number;
  readonly bootDelayMs: number;
  readonly intervalMs: number;
  readonly log: (line: string) => void;
}

export const DEFAULT_FILE_SCAN_JOB_OPTIONS: FileScanJobOptions = {
  debounceMs: 1_000,
  bootDelayMs: 5_000,
  intervalMs: 5 * 60_000,
  log: (line) => console.warn(line),
};

export function fileScanJobEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['WORKER_INPROCESS'] === '1' || env['FILE_SCAN_INPROCESS'] === '1';
}

/** What `FilesService` sees: a request for a pass, nothing more. */
export interface ScanRequester {
  request(): void;
}

export class FileScanJob implements ScanRequester, OnApplicationBootstrap, OnModuleDestroy {
  private running: Promise<void> | null = null;
  private again = false;
  private pending: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly verifier: Pick<FileVerifier, 'verify'>,
    private readonly scanner: Pick<FileScanner, 'scan'>,
    private readonly enabled: boolean,
    private readonly options: FileScanJobOptions = DEFAULT_FILE_SCAN_JOB_OPTIONS,
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

  /** One verify-then-scan pass now; resolves when it (and any coalesced follow-up) is done. */
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
      await this.pass();
    } while (this.again && !this.stopped);
  }

  private async pass(): Promise<void> {
    try {
      const verified = await this.verifier.verify();
      this.options.log(`[verifier] pass: ${describeVerification(verified)}`);
      const scanned = await this.scanner.scan();
      this.options.log(`[scanner] pass: ${describeScan(scanned)}`);
    } catch (error) {
      // An unreachable store or scanner stops this pass; the next request or tick retries.
      this.options.log(`[scanner] pass failed: ${JSON.stringify(describeFailure(error))}`);
    }
  }
}
