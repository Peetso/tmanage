import { describe, expect, it } from 'vitest';
import type { WorkerDatabase, WorkerTransaction } from '../common/database/worker-database.js';
import { GROWTH_SQL } from '../common/database/growth-rollup-store.js';
import { SCHEDULED_JOB_NAMES, createScheduledJobs, runScheduledJobLoop } from './scheduled-jobs.js';
import type { ScheduledJob } from './scheduled-jobs.js';

/** A pool that answers every statement from `answer` and records what was asked. */
function fakeDatabase(answer: (sql: string) => unknown): WorkerDatabase & { asked: string[] } {
  const asked: string[] = [];
  const tx = {
    query: (sql: string) => {
      asked.push(sql);
      return Promise.resolve(answer(sql));
    },
  } as unknown as WorkerTransaction;
  return {
    asked,
    read: (work) => work(tx),
    transaction: (work) => work(tx),
    end: () => Promise.resolve(),
  };
}

const ENV = { WEB_PUBLIC_URL: 'https://tmanageapp.com' };
const MAIL = { alerts: null, notice: () => null };

function growthJob(database: WorkerDatabase): ScheduledJob {
  const job = createScheduledJobs(database, ENV, MAIL).find((j) => j.name === 'growth-rollup');
  if (job === undefined) throw new Error('no growth-rollup job');
  return job;
}

describe('createScheduledJobs (GROWTH-FIX)', () => {
  it('builds every listed job, each with a cadence', () => {
    const jobs = createScheduledJobs(
      fakeDatabase(() => []),
      ENV,
      MAIL,
    );
    expect(jobs.map((j) => j.name)).toEqual([...SCHEDULED_JOB_NAMES]);
    for (const job of jobs) expect(job.intervalMs).toBeGreaterThan(0);
  });

  it('computes the growth figures when none exist yet (first boot)', async () => {
    const database = fakeDatabase((sql) =>
      sql === GROWTH_SQL.lastComputed
        ? [{ at: null }]
        : sql.startsWith('delete')
          ? { affectedRows: 0 }
          : [],
    );
    const line = await growthJob(database).run();
    expect(line).toMatch(/row\(s\) written/u);
    const upsert = GROWTH_SQL.upsert(1).split('(')[0] ?? '';
    expect(database.asked.some((sql) => sql.startsWith(upsert))).toBe(true);
  });

  it('leaves fresh growth figures alone', async () => {
    const database = fakeDatabase(() => [{ at: new Date() }]);
    expect(await growthJob(database).run()).toBeNull();
    expect(database.asked).toEqual([GROWTH_SQL.lastComputed]);
  });
});

describe('runScheduledJobLoop', () => {
  it('runs the pass under the job name and skips it while another process holds the lock', async () => {
    const controller = new AbortController();
    const asked: string[] = [];
    let passes = 0;
    const job: ScheduledJob = {
      name: 'growth-rollup',
      intervalMs: 60_000,
      run: () => {
        passes += 1;
        return Promise.resolve('moved');
      },
    };
    await runScheduledJobLoop(job, controller.signal, {
      run: (name) => {
        asked.push(name);
        controller.abort();
        return Promise.resolve({ ran: false });
      },
    });
    expect(asked).toEqual(['growth-rollup']);
    expect(passes).toBe(0);
  });
});
