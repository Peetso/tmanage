import { describe, expect, it, vi } from 'vitest';
import { downloadStateFor } from './file-download.service.js';
import { FileScanJob, fileScanJobEnabled } from './file-scan-job.js';
import type { FileScanJobOptions } from './file-scan-job.js';

const verifyReport = {
  organizations: 0,
  scanned: 0,
  verified: 0,
  rejected: 0,
  skipped: 0,
  failed: 0,
  reran: 0,
};
const scanReport = { ...verifyReport, ready: 0, unscanned: 0 };
const options: FileScanJobOptions = {
  debounceMs: 0,
  bootDelayMs: 0,
  intervalMs: 60_000,
  log: () => {},
};

function job(enabled = true, verify = vi.fn(async () => verifyReport)) {
  const scan = vi.fn(async () => scanReport);
  return { verify, scan, job: new FileScanJob({ verify }, { scan }, enabled, options) };
}

describe('FileScanJob (CQ-09)', () => {
  it('runs verify then scan, and coalesces a request made mid-pass into exactly one more pass', async () => {
    let release: () => void = () => {};
    const verify = vi.fn(
      () => new Promise<typeof verifyReport>((done) => (release = () => done(verifyReport))),
    );
    const t = job(true, verify);
    const first = t.job.runNow();
    t.job.request();
    t.job.request();
    release();
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(2));
    release();
    await first;
    expect(t.scan).toHaveBeenCalledTimes(2);
  });

  it('does nothing when disabled, and a failing pass is logged, not thrown', async () => {
    const off = job(false);
    off.job.request();
    off.job.onApplicationBootstrap();
    await new Promise((done) => setTimeout(done, 5));
    expect(off.verify).not.toHaveBeenCalled();

    const failing = job(
      true,
      vi.fn(async () => Promise.reject(new Error('store down'))),
    );
    await expect(failing.job.runNow()).resolves.toBeUndefined();
    expect(failing.scan).not.toHaveBeenCalled();
    await failing.job.onModuleDestroy();
  });

  it('is enabled by WORKER_INPROCESS=1 or FILE_SCAN_INPROCESS=1 only', () => {
    expect(fileScanJobEnabled({ WORKER_INPROCESS: '1' })).toBe(true);
    expect(fileScanJobEnabled({ FILE_SCAN_INPROCESS: '1' })).toBe(true);
    expect(fileScanJobEnabled({})).toBe(false);
  });

  it('reports a rejected file as blocked and everything not yet ready as pending_scan', () => {
    expect(downloadStateFor('rejected')).toBe('blocked');
    expect(downloadStateFor('scanning')).toBe('pending_scan');
    expect(downloadStateFor('verifying')).toBe('pending_scan');
  });
});
