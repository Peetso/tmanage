import { describe, expect, it } from 'vitest';
import { ApiRequestError, NetworkError } from '../src/lib/api/errors';
import { isApiNotFound } from '../src/lib/api/not-found';

describe('B15 unknown project id', () => {
  it('treats only an API 404 as not found', () => {
    expect(isApiNotFound(new ApiRequestError(404, 'not_found', 'gone', 'c1'))).toBe(true);
    expect(isApiNotFound(new ApiRequestError(403, 'forbidden', 'no', 'c2'))).toBe(false);
    expect(isApiNotFound(new NetworkError('offline'))).toBe(false);
  });
});
