import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { serializeForLog } from '../../common/observability/logger.js';
import {
  evaluateSourceFindings,
  longestWindowMinutes,
  windowStartOf,
  FINDING_RULE_DEFAULTS,
} from './source-findings.js';
import { FINDINGS_RETENTION_MS } from './source-findings.repository.js';
import type { SourceFindingsStore } from './source-findings.repository.js';

/**
 * SEC-ALERTS — the source-findings pass, run inside the API process every minute.
 *
 * One pass: read the thresholds, read the longest window of `authentication_events`, evaluate the
 * rules (`source-findings.ts`), upsert the findings, prune old ones. The worker's detector reads
 * the findings on its own tick and the dispatcher mails a high one at once (no digest wait), so an
 * attack reaches `ALERT_EMAILS` within this interval plus the detector interval (1 + 2 minutes;
 * target 5, SECURITY-INCIDENT-2026-11-21).
 *
 * RT-2/RT-3: a second copy of this job (restart overlap, a second instance) is **harmless when
 * duplicated**, by construction rather than by a lease: every write is an idempotent upsert on the
 * finding's natural key with `greatest()`, and the prune is a bounded `DELETE … LIMIT`. Nothing is
 * mailed from here. So it needs no leader lease.
 *
 * Off unless the deployment runs background work in this process (`WORKER_INPROCESS=1`, the
 * Hostinger switch) or `SECURITY_FINDINGS_INPROCESS=1` (a local API beside a standalone worker);
 * a test or CLI that composes the module must not race a pass of its own (`file-scan-job.ts`).
 */
export const SOURCE_FINDINGS_JOB = Symbol.for('tmanage.SourceFindingsJob');
export const SOURCE_FINDINGS_INTERVAL_MS = 60_000;
const BOOT_DELAY_MS = 15_000;

export function sourceFindingsJobEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['WORKER_INPROCESS'] === '1' || env['SECURITY_FINDINGS_INPROCESS'] === '1';
}

export interface SourceFindingsPassResult {
  readonly findings: number;
}

/** One bounded pass; exported for the unit test. */
export async function runSourceFindingsPass(
  store: SourceFindingsStore,
  now: Date,
): Promise<SourceFindingsPassResult> {
  const thresholds = await store.thresholds();
  const since = new Date(now.getTime() - longestWindowMinutes(thresholds) * 60_000);
  const findings = evaluateSourceFindings(await store.authEvents(since), thresholds, now);
  await store.writeFindings(
    findings.map((f) => ({
      ...f,
      windowStart: windowStartOf(
        f.lastSeen,
        (thresholds.get(f.ruleKey) ?? FINDING_RULE_DEFAULTS[f.ruleKey])?.windowMinutes ?? 10,
      ),
    })),
  );
  await store.prune(new Date(now.getTime() - FINDINGS_RETENTION_MS));
  return { findings: findings.length };
}

export class SourceFindingsJob implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private running = false;
  private failedOnce = false;

  constructor(
    private readonly store: SourceFindingsStore,
    private readonly enabled: boolean,
    private readonly log: (line: string, error?: unknown) => void = (line, error) =>
      console.error(line, error === undefined ? '' : serializeForLog(error)),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.timer = setTimeout(() => void this.tick(), BOOT_DELAY_MS);
    this.timer.unref();
    this.interval = setInterval(() => void this.tick(), SOURCE_FINDINGS_INTERVAL_MS);
    this.interval.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.interval !== null) clearInterval(this.interval);
    this.timer = null;
    this.interval = null;
  }

  /** One pass at a time; a failure is logged once until a pass succeeds again (no log flood). */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await runSourceFindingsPass(this.store, this.clock());
      this.failedOnce = false;
    } catch (error) {
      if (!this.failedOnce) this.log('[security] source findings pass failed', error);
      this.failedOnce = true;
    } finally {
      this.running = false;
    }
  }
}
