import { describe, expect, it } from 'vitest';
import { readDriveReturn } from '../src/lib/api/google-drive';

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
});
