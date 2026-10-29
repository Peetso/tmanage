import { describe, expect, it } from 'vitest';
import {
  isRedactedField,
  MAX_CHANGE_VALUE_LENGTH,
  redactChanges,
  redactedJson,
  REDACTED_MARK,
} from './audit-redaction.js';

/** SPEC §6 0241: secret-ish fields never stored, every value capped at 2000 characters. */

describe('audit redaction', () => {
  it('redacts password*, *token*, *secret*, *hash*, refresh_* — any case', () => {
    for (const field of [
      'password',
      'passwordHash',
      'password_reset_at',
      'access_token',
      'apiTokenId',
      'clientSecret',
      'webhook_secret',
      'hash',
      'content_hash',
      'refresh_family',
      'refreshCount',
    ]) {
      expect(isRedactedField(field), field).toBe(true);
    }
    for (const field of ['title', 'email', 'role', 'body', 'display_name']) {
      expect(isRedactedField(field), field).toBe(false);
    }
  });

  it('drops redacted values and marks the row', () => {
    expect(
      redactChanges([
        { field: 'password_hash', before: 'old', after: 'new' },
        { field: 'title', before: 'A', after: 'B' },
      ]),
    ).toEqual([
      { field: 'password_hash', before: null, after: null, redacted: true },
      { field: 'title', before: 'A', after: 'B', redacted: false },
    ]);
  });

  it('caps values at 2000 characters and stringifies non-strings', () => {
    const long = 'x'.repeat(2500);
    const [row] = redactChanges([{ field: 'body', before: long, after: { n: 1 } }]);
    expect(row?.before).toHaveLength(MAX_CHANGE_VALUE_LENGTH);
    expect(row?.after).toBe('{"n":1}');
    expect(redactChanges([{ field: 'x', before: null, after: undefined }])[0]).toMatchObject({
      before: null,
      after: null,
    });
    expect(redactChanges([{ field: '  ', before: 1, after: 2 }])).toEqual([]);
  });

  it('redacts nested keys in platform before/after JSON', () => {
    const json = redactedJson({
      email: 'a@b.test',
      nested: { refresh_token: 'r', note: 'y'.repeat(2100) },
    });
    const parsed = JSON.parse(json ?? 'null') as {
      email: string;
      nested: { refresh_token: string; note: string };
    };
    expect(parsed.email).toBe('a@b.test');
    expect(parsed.nested.refresh_token).toBe(REDACTED_MARK);
    expect(parsed.nested.note).toHaveLength(MAX_CHANGE_VALUE_LENGTH);
    expect(redactedJson(undefined)).toBeNull();
  });
});
