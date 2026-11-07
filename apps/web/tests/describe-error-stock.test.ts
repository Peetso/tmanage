import { describe, expect, it } from 'vitest';
import { describeApiError } from '../src/lib/api/describe-error';
import { ApiRequestError } from '../src/lib/api/errors';

/** C9: the API's fixed refusal sentences come from the catalog, a service's own wording does not. */
describe('describeApiError stock messages', () => {
  const t = (key: string, english: string) =>
    key === 'ApiError.stock.notFound' ? 'غير موجود' : english;

  it('translates the stock not-found sentence and keeps a custom message as written', () => {
    const stock = new ApiRequestError(
      404,
      'not_found',
      'The requested resource was not found',
      'c',
    );
    const custom = new ApiRequestError(409, 'conflict', 'That name is already taken', 'c');
    expect(describeApiError(stock, t)).toBe('غير موجود');
    expect(describeApiError(custom, t)).toBe('That name is already taken');
  });
});
