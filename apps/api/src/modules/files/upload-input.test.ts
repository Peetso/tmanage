import { describe, expect, it } from 'vitest';
import { parseParts, parseUploadBody, requiredIdempotencyKey } from './upload-input.js';
import type { ValidationDetail } from './upload-input.js';
import { mayUploadFor } from './purpose-policy.js';

const MAX = 104_857_600;

const good = () => ({
  projectId: '019203a4-5b6c-7d8e-9f01-23456789abce',
  fileName: 'brief.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1_024,
  purpose: 'deliverable',
});

function fields(details: ValidationDetail[]): string[] {
  return details.map((d) => d.field);
}

describe('parseUploadBody', () => {
  it('accepts the contract shape and defaults the audience to internal', () => {
    const details: ValidationDetail[] = [];
    const parsed = parseUploadBody(good(), MAX, details);
    expect(details).toEqual([]);
    expect(parsed).toMatchObject({
      ...good(),
      contentHash: null,
      objectId: null,
      audience: 'internal',
    });
  });

  it('refuses a size above the effective ceiling before anything else happens', () => {
    // 50-BOOTSTRAP §5's 100 MB, not the contract's 5 GiB. Reversal: compare against
    // CONTRACT_MAX_SIZE_BYTES alone and this parses.
    const details: ValidationDetail[] = [];
    expect(parseUploadBody({ ...good(), sizeBytes: MAX + 1 }, MAX, details)).toBeUndefined();
    expect(fields(details)).toEqual(['sizeBytes']);
  });

  it('refuses a zero, negative, fractional or missing size', () => {
    for (const sizeBytes of [0, -1, 1.5, '1024', undefined]) {
      const details: ValidationDetail[] = [];
      parseUploadBody({ ...good(), sizeBytes }, MAX, details);
      expect(fields(details), String(sizeBytes)).toContain('sizeBytes');
    }
  });

  it('refuses a name that looks like a path', () => {
    for (const fileName of ['../brief.pdf', 'a/b.pdf', 'a\\b.pdf', '']) {
      const details: ValidationDetail[] = [];
      parseUploadBody({ ...good(), fileName }, MAX, details);
      expect(fields(details), JSON.stringify(fileName)).toContain('fileName');
    }
  });

  it('refuses a purpose outside the enum and an audience outside the two a caller may ask for', () => {
    const details: ValidationDetail[] = [];
    parseUploadBody(
      { ...good(), purpose: 'avatar', audience: 'client_action_required' },
      MAX,
      details,
    );
    expect(fields(details)).toEqual(['purpose', 'audience']);
  });

  it('requires a lowercase hex SHA-256 when a hash is offered', () => {
    const details: ValidationDetail[] = [];
    parseUploadBody({ ...good(), contentHash: 'ABC' }, MAX, details);
    expect(fields(details)).toEqual(['contentHash']);
    const ok: ValidationDetail[] = [];
    const parsed = parseUploadBody({ ...good(), contentHash: 'a'.repeat(64) }, MAX, ok);
    expect(ok).toEqual([]);
    expect(parsed?.contentHash).toBe('a'.repeat(64));
  });
});

describe('requiredIdempotencyKey', () => {
  it('names the header as the field when it is absent or too short', () => {
    for (const raw of [undefined, '', 'short', 'has space in it xx', 'x'.repeat(129)]) {
      const details: ValidationDetail[] = [];
      expect(requiredIdempotencyKey(raw, details)).toBeUndefined();
      expect(fields(details)).toEqual(['Idempotency-Key']);
    }
    const details: ValidationDetail[] = [];
    expect(requiredIdempotencyKey('brief-upload-2026-09-03', details)).toBe(
      'brief-upload-2026-09-03',
    );
    expect(details).toEqual([]);
  });
});

describe('parseParts', () => {
  it('requires a non-empty array of numbered parts with etags', () => {
    for (const body of [{}, { parts: [] }, { parts: 'x' }]) {
      const details: ValidationDetail[] = [];
      parseParts(body, details);
      expect(fields(details)).toEqual(['parts']);
    }
    const details: ValidationDetail[] = [];
    parseParts({ parts: [{ partNumber: 0, etag: 'e' }, { partNumber: 1 }] }, details);
    expect(fields(details)).toEqual(['parts[0].partNumber', 'parts[1].etag']);
  });
});

describe('mayUploadFor — the purpose table no document states', () => {
  it('lets a client attach to a request and nothing else', () => {
    expect(mayUploadFor('client', 'request_attachment')).toBe(true);
    expect(mayUploadFor('client', 'message_attachment')).toBe(false);
    expect(mayUploadFor('client', 'deliverable')).toBe(false);
    expect(mayUploadFor('client', 'document')).toBe(false);
  });

  it('lets the studio upload for everything but documents, which nobody has built', () => {
    expect(mayUploadFor('internal', 'request_attachment')).toBe(true);
    expect(mayUploadFor('internal', 'message_attachment')).toBe(true);
    expect(mayUploadFor('internal', 'deliverable')).toBe(true);
    expect(mayUploadFor('internal', 'document')).toBe(false);
  });
});
