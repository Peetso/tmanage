import { describe, expect, it } from 'vitest';
import { briefingSubjectKey } from '@tmanage/domain';
import type { BriefingSubject, OpenSignal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../../common/database/tenant-context.js';
import type { OptionalModuleFlag } from '../../admin/feature-flags.service.js';
import type { HomeBriefingRepository } from '../../home/home-briefing.repository.js';
import { FakeDigestBatchClient } from './digest-wording-batch.js';
import type { DigestBatchResult } from './digest-wording-batch.js';
import { DigestWordingJob, digestWordingEnabled, linesSha256 } from './digest-wording-job.js';
import type { DigestWordingDeps } from './digest-wording-job.js';
import type {
  DigestWordingRepository,
  DigestWordingRow,
  SubmittedWording,
} from './digest-wording.repository.js';

const ORG = '0195f0a0-0000-7000-8000-000000000001';
const SWEPT = new Date('2026-11-16T05:00:00.000Z');
const NOW = new Date('2026-11-16T06:00:00.000Z');

const signal = (
  signalId: string,
  rule: OpenSignal['rule'],
  subjectType: OpenSignal['subjectType'],
  subjectId: string,
  measure: number,
  threshold: number,
): OpenSignal => ({
  signalId,
  rule,
  subjectType,
  subjectId,
  projectId: 'p1',
  measure,
  threshold,
});

const SIGNALS: readonly OpenSignal[] = [
  signal('a1', 'overdue_invoice', 'client_invoice', 'i1', 12, 7),
  signal('b2', 'stale_task', 'work_item', 'w1', 16, 14),
  signal('c3', 'overloaded_person', 'membership', 'm1', 115, 100),
];

const subject = (title: string, patch: Partial<BriefingSubject> = {}): BriefingSubject => ({
  title,
  context: null,
  amount: null,
  category: null,
  deliverableId: null,
  ...patch,
});

const SUBJECTS = new Map<string, BriefingSubject>([
  [
    briefingSubjectKey('client_invoice', 'i1'),
    subject('INV-0038', { context: 'Cedar Foods', amount: { minor: 420_000, currency: 'USD' } }),
  ],
  [briefingSubjectKey('work_item', 'w1'), subject('Footer redesign')],
  [briefingSubjectKey('membership', 'm1'), subject('Omar Adel')],
]);

const GOOD =
  'Cedar Foods still owes $4,200 on [1], 12 days overdue. [2] is planned at 115% of capacity, ' +
  'and [3] has not moved for 16 days.';

const USAGE = {
  inputTokens: 300,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 80,
};

class MemoryWordings {
  readonly rows: (DigestWordingRow & {
    body: string | null;
    reason: string | null;
    organizationId: string;
  })[] = [];

  asRepository(): DigestWordingRepository {
    return {
      organizationsWithSweeps: () => Promise.resolve([ORG]),
      organizationsWithSubmitted: () =>
        Promise.resolve(this.rows.some((r) => r.status === 'submitted') ? [ORG] : ([] as string[])),
      findByLines: (_r: unknown, context: TenantContext, sha: string) =>
        Promise.resolve(
          this.rows.find(
            (r) => r.organizationId === context.organizationId && r.linesSha256 === sha,
          ) ?? null,
        ),
      submitted: () => Promise.resolve(this.rows.filter((r) => r.status === 'submitted')),
      insertSubmitted: (_r: unknown, context: TenantContext, row: SubmittedWording) => {
        if (this.rows.some((r) => r.linesSha256 === row.linesSha256)) return Promise.resolve(false);
        this.rows.push({
          id: row.id,
          organizationId: context.organizationId,
          linesSha256: row.linesSha256,
          status: 'submitted',
          batchId: row.batchId,
          taskId: row.taskId,
          callId: row.callId,
          body: null,
          reason: null,
        });
        return Promise.resolve(true);
      },
      conclude: (
        _r: unknown,
        _c: TenantContext,
        id: string,
        outcome: { status: DigestWordingRow['status']; body: string | null; reason: string | null },
      ) => {
        const row = this.rows.find((r) => r.id === id && r.status === 'submitted');
        if (row === undefined) return Promise.resolve(false);
        Object.assign(row, { status: outcome.status, body: outcome.body, reason: outcome.reason });
        return Promise.resolve(true);
      },
    } as unknown as DigestWordingRepository;
  }
}

interface Setup {
  readonly flags?: Partial<Record<OptionalModuleFlag, boolean>>;
  readonly signals?: () => readonly OpenSignal[];
  readonly answer?: (customId: string) => Omit<DigestBatchResult, 'customId'>;
  readonly openRefused?: boolean;
  readonly reserveRefused?: boolean;
}

function setup(options: Setup = {}) {
  const calls: string[] = [];
  const wordings = new MemoryWordings();
  const signals = options.signals ?? (() => SIGNALS);
  const briefing = {
    team: () => Promise.resolve(new Set<string>()),
    lastSweep: () => Promise.resolve(SWEPT),
    openSignals: () => Promise.resolve(signals()),
    subjects: () => Promise.resolve(SUBJECTS),
  } as unknown as HomeBriefingRepository;
  const database = {
    bootstrapRead: (_o: unknown, work: (db: unknown) => unknown) => work({}),
    read: (_c: unknown, work: (db: unknown) => unknown) => work({}),
    transaction: (_c: unknown, work: (tx: unknown) => unknown) => work({}),
  } as unknown as TenantDatabase;
  let n = 0;
  const budget: DigestWordingDeps['budget'] = {
    openTask: (_c, input) => {
      calls.push(`open:${input.tier}:${String(input.systemJob)}`);
      if (options.openRefused === true) {
        return Promise.resolve({ ok: false, reason: 'not_on_test_list' } as never);
      }
      return Promise.resolve({
        ok: true,
        value: {
          taskId: `task-${String((n += 1))}`,
          tier: 'low',
          model: 'claude-haiku-test',
          pool: 'workspace',
          payer: 'platform',
          ceilingCredits: 1,
        },
      } as never);
    },
    reserveCall: (_c, input) => {
      calls.push(`reserve:${input.taskId}`);
      if (options.reserveRefused === true) {
        return Promise.resolve({ ok: false, reason: 'over_ceiling' } as never);
      }
      return Promise.resolve({
        ok: true,
        value: {
          callId: `call-${input.taskId}`,
          model: 'claude-haiku-test',
          holdMicroUsd: 10,
          holdExpiresAt: NOW,
        },
      });
    },
    markSent: (_c, callId) => {
      calls.push(`sent:${callId}`);
      return Promise.resolve({ ok: true, value: null } as never);
    },
    settleCall: (_c, input) => {
      calls.push(`settle:${input.callId}:${String(input.usage.outputTokens)}`);
      return Promise.resolve({ ok: true, value: null } as never);
    },
    releaseCall: (_c, callId) => {
      calls.push(`release:${callId}`);
      return Promise.resolve({ ok: true, value: null });
    },
    finishTask: (_c, taskId, outcome) => {
      calls.push(`finish:${taskId}:${outcome}`);
      return Promise.resolve({ ok: true, value: null } as never);
    },
  };
  const batch = new FakeDigestBatchClient(
    (item) =>
      options.answer?.(item.customId) ?? {
        outcome: 'succeeded',
        text: GOOD,
        usage: USAGE,
        stopReason: 'end_turn',
        providerMessageId: 'msg_fake',
      },
  );
  const flags = {
    copilot: true,
    business_briefing: true,
    ai_digest_wording: true,
    ...options.flags,
  } as Readonly<Record<OptionalModuleFlag, boolean>>;
  const job = new DigestWordingJob(
    {
      database,
      repository: wordings.asRepository(),
      briefing,
      budget,
      batch,
      flags: () => Promise.resolve(flags),
      now: () => NOW,
      log: () => undefined,
    },
    true,
  );
  return { job, batch, calls, wordings };
}

describe('digest wording job (62-28)', () => {
  it('starts only when switched on in the environment', () => {
    expect(digestWordingEnabled({})).toBe(false);
    expect(digestWordingEnabled({ DIGEST_WORDING_INPROCESS: '1' })).toBe(true);
  });

  it('never starts without a batch client, whatever the environment says', async () => {
    const job = new DigestWordingJob(
      { ...({} as DigestWordingDeps), batch: null, log: () => undefined },
      true,
    );
    job.onApplicationBootstrap();
    expect(await job.pass()).toEqual({ submitted: 0, ready: 0, rejected: 0, failed: 0 });
    await job.onModuleDestroy();
  });

  it.each(['copilot', 'business_briefing', 'ai_digest_wording'] as const)(
    'flag %s off: no task, no batch, the template stays',
    async (flag) => {
      const { job, batch, calls } = setup({ flags: { [flag]: false } });
      expect(await job.pass()).toMatchObject({ submitted: 0 });
      expect(batch.submitted).toHaveLength(0);
      expect(calls).toEqual([]);
    },
  );

  it('under three signals: nothing is asked (the template is the whole section)', async () => {
    const { job, batch, calls } = setup({ signals: () => SIGNALS.slice(0, 2) });
    await job.pass();
    expect(batch.submitted).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it('three signals: one Low platform task, one held call, one batch item with numbered facts only', async () => {
    const { job, batch, calls, wordings } = setup();
    batch.ended = false;
    expect(await job.pass()).toMatchObject({ submitted: 1 });
    expect(calls).toEqual(['open:low:digest_wording', 'reserve:task-1', 'sent:call-task-1']);
    expect(batch.submitted).toHaveLength(1);
    const item = batch.submitted[0]![0]!;
    expect(item.request.model).toBe('claude-haiku-test');
    const content = JSON.stringify(item.request.messages);
    for (const name of ['INV-0038', 'Footer redesign', 'Omar Adel', '4200.00 USD']) {
      expect(content).toContain(name);
    }
    for (const id of ['a1', 'i1', 'w1', 'm1', ORG]) expect(content).not.toContain(`"${id}"`);
    expect(wordings.rows).toMatchObject([
      {
        status: 'submitted',
        // The section's order: money to collect, people overloaded, stale work.
        linesSha256: linesSha256([SIGNALS[0]!, SIGNALS[2]!, SIGNALS[1]!]),
        batchId: 'msgbatch_fake_1',
      },
    ]);
    // The same section is not asked twice while it waits.
    await job.pass();
    expect(batch.submitted).toHaveLength(1);
  });

  it('collect: a checked answer is stored ready, the call settled at its usage, the task closed', async () => {
    const { job, batch, calls, wordings } = setup();
    batch.ended = false;
    await job.pass();
    batch.ended = true;
    expect(await job.pass()).toMatchObject({ ready: 1, submitted: 0 });
    expect(wordings.rows[0]).toMatchObject({ status: 'ready', body: GOOD, reason: null });
    expect(calls).toContain('settle:call-task-1:80');
    expect(calls).toContain('finish:task-1:completed');
  });

  it('collect: an answer that invents a figure is rejected and never stored as wording', async () => {
    const { job, batch, wordings } = setup({
      answer: () => ({
        outcome: 'succeeded',
        text: GOOD.replace('16 days', '30 days'),
        usage: USAGE,
        stopReason: 'end_turn',
        providerMessageId: 'msg_fake',
      }),
    });
    batch.ended = false;
    await job.pass();
    batch.ended = true;
    expect(await job.pass()).toMatchObject({ rejected: 1 });
    expect(wordings.rows[0]).toMatchObject({
      status: 'rejected',
      body: null,
      reason: 'invented_figure',
    });
  });

  it('collect: a section that changed meanwhile is rejected as section_changed', async () => {
    let current: readonly OpenSignal[] = SIGNALS;
    const { job, batch, wordings } = setup({ signals: () => current });
    batch.ended = false;
    await job.pass();
    current = [...SIGNALS, signal('d4', 'stale_task', 'work_item', 'w1', 20, 14)];
    batch.ended = true;
    await job.pass();
    expect(wordings.rows[0]).toMatchObject({ status: 'rejected', reason: 'section_changed' });
  });

  it('collect: an errored item fails, with no settle and a failed task', async () => {
    const { job, batch, calls, wordings } = setup({
      answer: () => ({
        outcome: 'errored',
        text: null,
        usage: null,
        stopReason: null,
        providerMessageId: null,
      }),
    });
    batch.ended = false;
    await job.pass();
    batch.ended = true;
    expect(await job.pass()).toMatchObject({ failed: 1 });
    expect(wordings.rows[0]).toMatchObject({ status: 'failed', reason: 'errored' });
    expect(calls.some((c) => c.startsWith('settle:'))).toBe(false);
    expect(calls).toContain('finish:task-1:failed');
  });

  it('budget refusal: no batch; a refused hold closes its task as refused', async () => {
    const refusedOpen = setup({ openRefused: true });
    await refusedOpen.job.pass();
    expect(refusedOpen.batch.submitted).toHaveLength(0);
    expect(refusedOpen.calls).toEqual(['open:low:digest_wording']);

    const refusedHold = setup({ reserveRefused: true });
    await refusedHold.job.pass();
    expect(refusedHold.batch.submitted).toHaveLength(0);
    expect(refusedHold.calls).toEqual([
      'open:low:digest_wording',
      'reserve:task-1',
      'finish:task-1:refused',
    ]);
  });

  it('a batch that cannot be sent releases every hold and fails every task', async () => {
    const { job, batch, calls, wordings } = setup();
    batch.submit = () => Promise.reject(new Error('down'));
    expect(await job.pass()).toMatchObject({ failed: 1, submitted: 0 });
    expect(calls).toContain('release:call-task-1');
    expect(calls).toContain('finish:task-1:failed');
    expect(wordings.rows).toHaveLength(0);
  });
});
