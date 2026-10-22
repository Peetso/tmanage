import { describe, expect, it, vi } from 'vitest';
import { readDriveReturn, uploadToDrive } from '../src/lib/api/google-drive';
import type { ApiClient } from '../src/lib/api/client';

describe('Google Drive storage — the web half', () => {
  it('reads the callback fragment and nothing else', () => {
    expect(readDriveReturn('#drive=complete&code=abc&state=xyz')).toEqual({
      kind: 'complete',
      code: 'abc',
      state: 'xyz',
    });
    expect(readDriveReturn('#drive=error')).toEqual({ kind: 'error' });
    expect(readDriveReturn('#drive=complete&code=abc')).toBeNull();
    expect(readDriveReturn('')).toBeNull();
  });

  it('sends the bytes to Google directly, then attaches the uploaded file', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { uploadUrl: 'https://upload.google.test/session' } })
      .mockResolvedValueOnce({ data: { id: 'att-1', driveFileId: 'drive_file_1' } });
    const client = { request } as unknown as ApiClient;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'drive_file_1' })));
    const file = new File(['hello'], 'brief.txt', { type: 'text/plain' });

    const attached = await uploadToDrive(client, 'north', 'item-1', file, fetchImpl);

    expect(request.mock.calls[0]?.[0]).toMatchObject({
      method: 'POST',
      path: '/v1/organizations/north/work-items/item-1/google-drive/uploads',
      body: { name: 'brief.txt', mimeType: 'text/plain', size: 5 },
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://upload.google.test/session', {
      method: 'PUT',
      body: file,
    });
    expect(request.mock.calls[1]?.[0]).toMatchObject({ body: { driveFileId: 'drive_file_1' } });
    expect(attached).toMatchObject({ id: 'att-1' });
  });
});
