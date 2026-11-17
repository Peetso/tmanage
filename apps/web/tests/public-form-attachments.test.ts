import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/lib/api/client';
import { ApiRequestError } from '../src/lib/api/errors';
import {
  AttachmentError,
  attachmentProblem,
  uploadPublicFormFile,
} from '../src/lib/api/public-forms';

// 52-20a: the public form's attachment helpers — the browser's own check and the upload path.
const RULE = {
  maxFiles: 5,
  maxBytes: 25 * 1024 * 1024,
  mimeTypes: ['image/png', 'application/pdf'],
};

describe('52-20a public form attachments (web)', () => {
  it('explains a wrong type or a too-big file before sending anything', () => {
    expect(attachmentProblem({ size: 10, type: 'image/svg+xml' }, RULE)).toBe('wrong_type');
    expect(attachmentProblem({ size: RULE.maxBytes + 1, type: 'application/pdf' }, RULE)).toBe(
      'too_big',
    );
    expect(attachmentProblem({ size: 10, type: 'IMAGE/PNG' }, RULE)).toBeNull();
  });

  it('sends the token in a header, parts without cookies, and maps a refusal', async () => {
    const request = vi.fn(async (input: { path: string }) =>
      input.path.endsWith('/uploads')
        ? { data: { id: 's1', partSizeBytes: 4, uploadUrls: [{ partNumber: 1, url: 'u' }] } }
        : { data: {} },
    );
    const fetcher = vi.fn(async () => new Response(null, { headers: { etag: '"e"' } }));
    const file = new File(['abc'], 'brief.pdf', { type: 'application/pdf' });
    await uploadPublicFormFile({ request } as unknown as ApiClient, 'abcdefghjk', 'tok', file, {
      idempotencyKey: 'key-0123456789abcdef',
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      authentication: 'none',
      headers: { 'x-form-upload-token': 'tok' },
      body: { fileName: 'brief.pdf', sizeBytes: 3 },
    });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit' });

    const refusing = vi.fn(async () => {
      throw new ApiRequestError(422, 'validation_failed', 'no', 'c', [
        { field: 'reason', message: 'type_not_allowed' },
      ]);
    });
    await expect(
      uploadPublicFormFile(
        { request: refusing } as unknown as ApiClient,
        'abcdefghjk',
        'tok',
        file,
      ),
    ).rejects.toEqual(new AttachmentError('wrong_type'));
  });
});
