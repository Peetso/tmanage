import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../common/http/errors.js';
import { DEFAULT_PRESETS } from './file-safety.js';
import { FilesService } from './files.service.js';

/**
 * 56-06 (R19-e) — the upload door's two new refusals, driven on the private seams with fakes:
 * the shared rule's 422 `file_not_allowed` (reason token only, one refused row) and a client's
 * 21st upload of the UTC day, a 429 `daily_upload_limit`.
 */
const context = { organizationId: 'org-1' } as never;

function harness(started: number, maxFileBytes = 10_000) {
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const database = {
    read: (_c: unknown, run: (r: unknown) => unknown) => run({}),
    transaction: (_c: unknown, run: (r: unknown) => unknown) => run({}),
  };
  const dailyUploads = { countSince: vi.fn().mockResolvedValue(started) };
  const safety = {
    read: () =>
      Promise.resolve({
        presets: DEFAULT_PRESETS,
        maxFileBytes,
        requireScanForClients: false,
        requireScanForClientsStored: true,
        scannerPresent: false,
      }),
  };
  const service = new FilesService(
    database as never,
    {} as never,
    {} as never,
    {} as never,
    null,
    {} as never,
    {} as never,
    {} as never,
    { uploadMaxBytes: 1_000 } as never,
    audit as never,
    null,
    null,
    null,
    safety,
    dailyUploads as never,
  );
  const seams = service as unknown as {
    requireFileSafety: (c: unknown, d: unknown) => Promise<void>;
    requireDailyAllowance: (c: unknown, d: unknown) => Promise<void>;
  };
  return {
    safetyCheck: seams.requireFileSafety.bind(service),
    daily: seams.requireDailyAllowance.bind(service),
    audit,
    dailyUploads,
  };
}

function draft(fileName: string, mimeType: string, sizeBytes = 100, kind = 'client') {
  return {
    principal: { kind, userId: 'user-1' },
    input: { fileName, mimeType, sizeBytes, purpose: 'request_attachment', projectId: 'p-1' },
  };
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('56-06 the upload door', () => {
  it('refuses a disguised executable with the reason token only, and records it', async () => {
    const t = harness(0);
    const error = await refusal(
      t.safetyCheck(context, draft('invoice.pdf.exe', 'application/pdf')),
    );
    expect([error.status, error.code]).toEqual([422, 'file_not_allowed']);
    expect(error.details).toEqual([{ field: 'reason', message: 'double_extension' }]);
    expect(t.audit.record.mock.calls[0]?.[2]).toMatchObject({
      action: 'upload_session.refused',
      metadata: { denial_code: 'file_not_allowed', file_safety_code: 'double_extension' },
    });
    await expect(t.safetyCheck(context, draft('brief.pdf', 'application/pdf'))).resolves.toBe(
      undefined,
    );
    const big = await refusal(
      t.safetyCheck(context, draft('brief.pdf', 'application/pdf', 20_000)),
    );
    expect(big.details).toEqual([{ field: 'reason', message: 'too_large' }]);
  });

  it('lets a client start 20 uploads in a UTC day and refuses the 21st with a 429', async () => {
    await expect(harness(19).daily(context, draft('a.pdf', 'application/pdf'))).resolves.toBe(
      undefined,
    );
    const t = harness(20);
    const error = await refusal(t.daily(context, draft('a.pdf', 'application/pdf')));
    expect([error.status, error.code]).toEqual([429, 'daily_upload_limit']);
    const since = t.dailyUploads.countSince.mock.calls[0]?.[3] as Date;
    expect(since.toISOString()).toMatch(/T00:00:00\.000Z$/u);
  });
});
