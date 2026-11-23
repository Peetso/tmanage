import { createHash } from 'node:crypto';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import {
  DIGEST_WORDING_MIN_LINES,
  DIGEST_WORDING_SYSTEM,
  assembleBriefing,
  checkDigestWording,
  digestLinesKey,
  digestSectionLines,
  digestWordingFacts,
  uuidv7,
} from '@tmanage/domain';
import type { BriefingLine, BriefingSource } from '@tmanage/domain';
import {
  createServiceContext,
  type TenantContext,
  type TenantDatabase,
  type TenantQueryRunner,
} from '../../../common/database/tenant-context.js';
import type { OptionalModuleFlag } from '../../admin/feature-flags.service.js';
import type { HomeBriefingRepository } from '../../home/home-briefing.repository.js';
import type { AiRequest } from '../ai-client.js';
import type {
  AiBudgetResult,
  AiBudgetService,
  OpenedTask,
  ReservedCall,
} from '../ai-budget.service.js';
import type { DigestBatchClient, DigestBatchItem } from './digest-wording-batch.js';
import type { DigestWordingRepository } from './digest-wording.repository.js';

/**
 * 62-28 (plan 62 §4.8) — the optional AI wording of the weekly digest's briefing, worded through a
 * message batch. Off by default three times over: the job starts only with a batch client and
 * `DIGEST_WORDING_INPROCESS=1`; a workspace is worded only while its `copilot`,
 * `business_briefing` and `ai_digest_wording` flags are all on; and the budget opens a task only
 * for a workspace on the AI test list. Everywhere else the digest is the plain template at zero
 * cost, which is also what every reader gets until a wording for their exact section is ready.
 *
 * One pass:
 *
 * 1. **Collect**: for every wording still in a batch, poll the batch. When it has ended, check each
 *    answer against the company's current section (`checkDigestWording`: every fact cited, none
 *    invented, figures only from the facts, plain text); store it `ready`, or `rejected` with the
 *    reason, or `failed`. Settle the call with the usage the batch reports and close the task.
 * 2. **Submit**: for every workspace whose flags are on, build the company-wide section (the
 *    owner's view: every group, money included); with at least three lines and no wording yet for
 *    exactly those lines, open a platform-paid `digest_wording` task (Low tier model), hold the
 *    call and add one request to this pass's batch. One batch per pass.
 *
 * Cost: a hold lives 15 minutes (`AI_CALL_HOLD_TTL_MS`) and a batch may take hours; a hold the
 * batch outlives is settled in full by the lost-hold sweep, so the ledger never under-counts. The
 * batch's half price is therefore not yet reflected in the ledger (open item in the lane report).
 *
 * The facts carry record names people wrote: the instruction says they are data, and the check
 * throws away any answer with a link, markup, an unknown fact number or a figure not in the facts.
 */

export const DIGEST_WORDING_JOB = Symbol.for('tmanage.DigestWordingJob');
export const DIGEST_WORDING_FLAG: OptionalModuleFlag = 'ai_digest_wording';
export const DIGEST_WORDING_MAX_TOKENS = 400;

export const DIGEST_WORDING_REASON =
  'finding which organizations have a finished signals sweep or a digest wording in a batch, so ' +
  'each can be worded or collected under its own service context (62-28)';

export function digestWordingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['DIGEST_WORDING_INPROCESS'] === '1';
}

export function linesSha256(lines: readonly Pick<BriefingLine, 'signalId'>[]): string {
  return createHash('sha256').update(digestLinesKey(lines)).digest('hex');
}

export interface DigestWordingDeps {
  readonly database: TenantDatabase;
  readonly repository: DigestWordingRepository;
  readonly briefing: HomeBriefingRepository;
  readonly budget: Pick<
    AiBudgetService,
    'openTask' | 'reserveCall' | 'markSent' | 'settleCall' | 'releaseCall' | 'finishTask'
  >;
  /** Null until a provider adapter and key exist: the job then never starts. */
  readonly batch: DigestBatchClient | null;
  readonly flags: (
    context: TenantContext,
  ) => Promise<Readonly<Record<OptionalModuleFlag, boolean>>>;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
}

export interface DigestWordingReport {
  readonly submitted: number;
  readonly ready: number;
  readonly rejected: number;
  readonly failed: number;
}

interface Pending {
  readonly context: TenantContext;
  readonly id: string;
  readonly sha: string;
  readonly lineCount: number;
  readonly task: OpenedTask;
  readonly call: ReservedCall;
  readonly item: DigestBatchItem;
}

function contextFor(organizationId: string, correlationId: string): TenantContext {
  return createServiceContext({ organizationId, correlationId, policyVersion: 'digest-wording' });
}

/** The request a section's wording is asked with (fixed instruction first, the cached prefix). */
export function digestWordingRequest(lines: readonly BriefingLine[], model: string): AiRequest {
  return {
    model: model as AiRequest['model'],
    maxTokens: DIGEST_WORDING_MAX_TOKENS,
    effort: 'low',
    // AI-ROUTER-FIX: thinking off, so the 400-token cap is all wording, never eaten by thinking.
    thinking: 'off',
    system: [{ text: DIGEST_WORDING_SYSTEM, cache: '1h' }],
    tools: [],
    messages: [{ role: 'user', content: JSON.stringify({ facts: digestWordingFacts(lines) }) }],
  };
}

export class DigestWordingJob implements OnApplicationBootstrap, OnModuleDestroy {
  private timers: NodeJS.Timeout[] = [];
  private running: Promise<void> | null = null;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(
    private readonly deps: DigestWordingDeps,
    private readonly enabled: boolean,
    private readonly intervalMs = 60 * 60_000,
  ) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((line) => console.warn(line));
  }

  onApplicationBootstrap(): void {
    if (!this.enabled || this.deps.batch === null) return;
    const tick = setInterval(() => void this.runNow(), this.intervalMs);
    tick.unref();
    this.timers = [tick];
  }

  async onModuleDestroy(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    await this.running;
  }

  async runNow(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.pass()
      .then((report) => {
        if (report.submitted + report.ready + report.rejected + report.failed > 0) {
          this.log(
            `[digest-wording] pass: ${String(report.submitted)} submitted, ${String(report.ready)} ready, ` +
              `${String(report.rejected)} rejected, ${String(report.failed)} failed`,
          );
        }
      })
      .catch((error: unknown) => {
        this.log(
          `[digest-wording] pass failed: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  async pass(): Promise<DigestWordingReport> {
    const correlationId = uuidv7();
    const tally = { submitted: 0, ready: 0, rejected: 0, failed: 0 };
    const batch = this.deps.batch;
    if (batch === null) return tally;
    const [withSubmitted, withSweeps] = await this.deps.database.bootstrapRead(
      {
        correlationId,
        reason: DIGEST_WORDING_REASON,
        tables: ['ai_digest_wordings', 'work_signal_sweeps'],
      },
      async (db) => [
        await this.deps.repository.organizationsWithSubmitted(db),
        await this.deps.repository.organizationsWithSweeps(db),
      ],
    );
    for (const organizationId of withSubmitted) {
      await this.collect(contextFor(organizationId, correlationId), batch, tally);
    }
    const pending: Pending[] = [];
    for (const organizationId of withSweeps) {
      const item = await this.prepare(contextFor(organizationId, correlationId));
      if (item !== null) pending.push(item);
    }
    if (pending.length > 0) await this.submit(batch, pending, tally);
    return tally;
  }

  /** The company-wide section's lines (owner's view), read with the card's own source. */
  private async companyLines(context: TenantContext): Promise<readonly BriefingLine[]> {
    const briefing = await this.deps.database.read(context, (runner) =>
      assembleBriefing(this.sourceOf(runner, context), {
        companyWide: true,
        finance: true,
        projectIds: new Set(),
        membershipId: '',
      }),
    );
    return briefing.audience === 'company' ? digestSectionLines(briefing.groups) : [];
  }

  private sourceOf(runner: TenantQueryRunner, context: TenantContext): BriefingSource {
    const repository = this.deps.briefing;
    return {
      team: (projectIds, membershipId) =>
        repository.team(runner, context, projectIds, membershipId),
      lastSweep: () => repository.lastSweep(runner, context),
      openSignals: (sweptAt) => repository.openSignals(runner, context, sweptAt),
      subjects: (signals) => repository.subjects(runner, context, signals),
    };
  }

  private async flagsOn(context: TenantContext): Promise<boolean> {
    const flags = await this.deps.flags(context);
    return flags.copilot && flags.business_briefing && flags[DIGEST_WORDING_FLAG];
  }

  private async prepare(context: TenantContext): Promise<Pending | null> {
    if (!(await this.flagsOn(context))) return null;
    const lines = await this.companyLines(context);
    if (lines.length < DIGEST_WORDING_MIN_LINES) return null;
    const sha = linesSha256(lines);
    const known = await this.deps.database.read(context, (runner) =>
      this.deps.repository.findByLines(runner, context, sha),
    );
    if (known !== null) return null;
    const opened = await this.deps.budget.openTask(context, {
      tier: 'low',
      activity: 'tasks',
      allowance: { workspaceCredits: 0, memberCredits: 0 },
      systemJob: 'digest_wording',
    });
    if (!opened.ok) return null;
    const draft = digestWordingRequest(lines, opened.value.model);
    const reserved: AiBudgetResult<ReservedCall> = await this.deps.budget.reserveCall(context, {
      taskId: opened.value.taskId,
      promptTokens: Buffer.byteLength(JSON.stringify(draft), 'utf8'),
      maxTokens: DIGEST_WORDING_MAX_TOKENS,
    });
    if (!reserved.ok) {
      await this.deps.budget.finishTask(context, opened.value.taskId, 'refused');
      return null;
    }
    const id = uuidv7();
    return {
      context,
      id,
      sha,
      lineCount: lines.length,
      task: opened.value,
      call: reserved.value,
      item: { customId: id, request: digestWordingRequest(lines, reserved.value.model) },
    };
  }

  private async submit(
    batch: DigestBatchClient,
    pending: readonly Pending[],
    tally: { submitted: number; failed: number },
  ): Promise<void> {
    let batchId: string;
    try {
      batchId = (await batch.submit(pending.map((entry) => entry.item))).batchId;
    } catch {
      for (const entry of pending) {
        await this.deps.budget.releaseCall(entry.context, entry.call.callId);
        await this.deps.budget.finishTask(entry.context, entry.task.taskId, 'failed');
        tally.failed += 1;
      }
      return;
    }
    const at = this.now();
    for (const entry of pending) {
      await this.deps.budget.markSent(entry.context, entry.call.callId);
      const stored = await this.deps.database.transaction(entry.context, (tx) =>
        this.deps.repository.insertSubmitted(tx, entry.context, {
          id: entry.id,
          linesSha256: entry.sha,
          lineCount: entry.lineCount,
          batchId,
          customId: entry.item.customId,
          taskId: entry.task.taskId,
          callId: entry.call.callId,
          model: entry.call.model,
          at,
        }),
      );
      if (stored) tally.submitted += 1;
    }
  }

  private async collect(
    context: TenantContext,
    batch: DigestBatchClient,
    tally: { ready: number; rejected: number; failed: number },
  ): Promise<void> {
    const rows = await this.deps.database.read(context, (runner) =>
      this.deps.repository.submitted(runner, context),
    );
    const byBatch = new Map<string, typeof rows>();
    for (const row of rows) {
      if (row.batchId === null) continue;
      byBatch.set(row.batchId, [...(byBatch.get(row.batchId) ?? []), row]);
    }
    if (byBatch.size === 0) return;
    const lines = await this.companyLines(context);
    const currentSha = linesSha256(lines);
    for (const [batchId, batchRows] of byBatch) {
      const poll = await batch.poll(batchId);
      if (!poll.ended) continue;
      const results = new Map(poll.results.map((result) => [result.customId, result]));
      for (const row of batchRows) {
        const result = results.get(row.id);
        let outcome: {
          status: 'ready' | 'rejected' | 'failed';
          body: string | null;
          reason: string | null;
        };
        if (result === undefined || result.outcome !== 'succeeded' || result.text === null) {
          outcome = { status: 'failed', body: null, reason: result?.outcome ?? 'missing' };
        } else if (row.linesSha256 !== currentSha) {
          outcome = { status: 'rejected', body: null, reason: 'section_changed' };
        } else {
          const check = checkDigestWording(result.text, lines);
          outcome = check.ok
            ? { status: 'ready', body: check.text, reason: null }
            : { status: 'rejected', body: null, reason: check.reason };
        }
        if (row.callId !== null && result?.usage !== undefined && result.usage !== null) {
          // Refused when the hold already expired: the lost-hold sweep settled it in full.
          await this.deps.budget.settleCall(context, {
            callId: row.callId,
            usage: result.usage,
            toolCalls: 0,
            latencyMs: null,
            stopReason: result.stopReason,
            providerMessageId: result.providerMessageId,
          });
        }
        // No usage (errored, expired, missing): the call is `sent`, which only a settle or the
        // lost-hold sweep may close; the sweep settles it at its full hold (never under-counts).
        if (row.taskId !== null) {
          await this.deps.budget.finishTask(
            context,
            row.taskId,
            outcome.status === 'failed' ? 'failed' : 'completed',
          );
        }
        const at = this.now();
        await this.deps.database.transaction(context, (tx) =>
          this.deps.repository.conclude(tx, context, row.id, outcome, at),
        );
        tally[outcome.status] += 1;
      }
    }
  }
}
