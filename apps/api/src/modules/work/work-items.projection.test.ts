import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkItemRow } from '../../common/database/schema.js';
import { toWorkItemView } from './work-items.service.js';

/**
 * x65 item A (carried from review-x60 Important). `toWorkItemView` fails closed on a row whose
 * persisted `state` is outside the domain union — but the throw alone surfaces only through
 * fastify's generic 500 and names no row to the operator. Before it throws, it must log the
 * offending row id and the request correlation id through the redaction path — and never the
 * row's contents (the bad `state` value in particular).
 */
describe('toWorkItemView — corrupt state row', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs the row id + correlation id (not the bad value) and then throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const correlationId = '00000000-0000-4000-8000-000000000abc';
    const row = { id: 'wi-corrupt', state: 'not_a_state' } as unknown as WorkItemRow;

    expect(() => toWorkItemView(row, correlationId)).toThrow(/wi-corrupt/);

    expect(error).toHaveBeenCalledTimes(1);
    const serialized = String(error.mock.calls[0]?.[1] ?? '');
    expect(serialized).toContain('wi-corrupt');
    expect(serialized).toContain(correlationId);
    // Row contents never reach the log sink — only the id and the correlation id do.
    expect(serialized).not.toContain('not_a_state');
  });
});
