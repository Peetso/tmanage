import { describe, expect, it, vi } from 'vitest';
import type { UploadSessionRow } from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { FilesService } from './files.service.js';
import type { PublicFormUploadTarget } from './files.service.js';
import { mayDownloadFor, mayUploadFor } from './purpose-policy.js';

/**
 * 52-20a — a public form visitor's upload. The door pins it to the owner's project and the token's
 * submission whatever the request says, keeps the public type/size rule (images and PDF, 25 MB),
 * holds a submission to five files, and lets a visitor reach only their own submission's uploads.
 */
const ORG = '00000000-0000-4000-8000-0000000000a1';
const target: PublicFormUploadTarget = {
  projectId: '00000000-0000-4000-8000-0000000000b1',
  ownerUserId: '00000000-0000-4000-8000-0000000000c1',
  submissionId: '00000000-0000-4000-8000-0000000000d1',
};
const context = { organizationId: ORG } as unknown as TenantContext;

function harness(held = 0, stored: Partial<UploadSessionRow> | null = null) {
  const run = (_c: unknown, work: (r: unknown) => unknown) => work({});
  const assets = { create: vi.fn(async () => ({ id: 'asset-1' })) };
  const sessions = {
    findByIdempotencyKey: vi.fn(async () => null),
    countForObject: vi.fn(async () => held),
    nextId: () => '00000000-0000-4000-8000-0000000000e1',
    findById: vi.fn(async () => stored),
    create: vi.fn(async (_tx: unknown, _c: unknown, row: Record<string, unknown>) => ({
      ...row,
      status: 'reserved',
      uploadTargetsJson: [{ partNumber: 1, url: 'https://up/1' }],
      createdAt: new Date(),
    })),
  };
  const files = new FilesService(
    { read: run, transaction: run } as never,
    sessions as never,
    assets as never,
    { ensure: vi.fn(), reserve: vi.fn(async () => true) } as never,
    null,
    { findById: vi.fn(async () => ({ id: target.projectId, archivedAt: null })) } as never,
    {} as never,
    {
      beginMultipart: vi.fn(async () => ({ providerUploadId: 'u1', parts: [] })),
      abortMultipart: vi.fn(),
    } as never,
    {
      uploadMaxBytes: 100 * 1024 * 1024,
      uploadPartSizeBytes: 8 * 1024 * 1024,
      uploadUrlTtlSeconds: 900,
      storageOrgBytesLimit: 10 ** 12,
    } as never,
    { record: vi.fn(async () => undefined) } as never,
    null,
    null,
  );
  return { files, assets, sessions };
}

const request = (fileName: string, mimeType: string, sizeBytes = 1_000) => ({
  // What a hostile visitor might send: none of it may decide where the file goes.
  projectId: '00000000-0000-4000-8000-0000000000ff',
  purpose: 'client_upload' as const,
  objectId: 'someone-elses-submission',
  audience: 'client_visible' as const,
  fileName,
  mimeType,
  sizeBytes,
  contentHash: null,
  idempotencyKey: 'key-0123456789abcdef',
});

describe('52-20a public form upload door', () => {
  it('is no signed-in purpose; only the team downloads it', () => {
    expect(mayUploadFor('internal', 'form_attachment')).toBe(false);
    expect(mayUploadFor('client', 'form_attachment')).toBe(false);
    expect(mayDownloadFor('internal', 'form_attachment')).toBe(true);
    expect(mayDownloadFor('client', 'form_attachment')).toBe(false);
  });

  it("pins the upload to the owner's project and the token's submission", async () => {
    const t = harness();
    const view = await t.files.createForPublicForm(
      context,
      target,
      request('brief.pdf', 'application/pdf'),
    );
    expect(t.assets.create).toHaveBeenCalledWith(
      {},
      context,
      expect.objectContaining({
        projectId: target.projectId,
        objectId: target.submissionId,
        purpose: 'form_attachment',
        ownerUserId: target.ownerUserId,
        audience: 'internal',
      }),
    );
    expect(view.uploadUrls).toHaveLength(1);
    expect(JSON.stringify(view)).not.toMatch(/projectId|fileAssetId|submission/u);
  });

  it.each([
    ['logo.svg', 'image/svg+xml', 1_000],
    ['page.html', 'text/html', 1_000],
    [
      'brief.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      1_000,
    ],
    ['big.pdf', 'application/pdf', 25 * 1024 * 1024 + 1],
  ])('refuses %s before anything is reserved', async (name, type, size) => {
    const t = harness();
    await expect(
      t.files.createForPublicForm(context, target, request(name, type, size)),
    ).rejects.toMatchObject({ status: 422, code: 'file_not_allowed' });
    expect(t.assets.create).not.toHaveBeenCalled();
  });

  it('holds one submission to five files', async () => {
    const t = harness(5);
    await expect(
      t.files.createForPublicForm(context, target, request('six.png', 'image/png')),
    ).rejects.toMatchObject({ status: 422, auditCode: 'form_attachment_limit' });
  });

  it("answers 404 for another submission's upload", async () => {
    const t = harness(0, {
      purpose: 'form_attachment',
      objectId: 'another-submission',
      projectId: target.projectId,
      actorUserId: target.ownerUserId,
    });
    await expect(
      t.files.completeForPublicForm(context, target, 'session-9', [{ partNumber: 1, etag: 'e' }]),
    ).rejects.toMatchObject({ status: 404 });
    await expect(t.files.cancelForPublicForm(context, target, 'session-9')).rejects.toMatchObject({
      status: 404,
    });
  });
});
