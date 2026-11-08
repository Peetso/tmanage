import { describe, expect, it } from 'vitest';
import { resolveClientAudience } from './work-item-client-audience.js';

/** C25: the "Which clients can see this?" list is checked against the project's clients. */
describe('resolveClientAudience', () => {
  const project = ['atlas', 'northwind', 'brightline'];

  it('refuses an empty list and a company that is not a client of the project', () => {
    expect(resolveClientAudience([], project)).toEqual({
      ok: false,
      message: 'choose at least one client',
    });
    expect(resolveClientAudience(['atlas', 'other-studio'], project).ok).toBe(false);
  });

  it('stores the ticked companies, and nothing when every project client is ticked', () => {
    expect(resolveClientAudience(['atlas', 'northwind', 'atlas'], project)).toEqual({
      ok: true,
      stored: ['atlas', 'northwind'],
    });
    expect(resolveClientAudience([...project], project)).toEqual({ ok: true, stored: [] });
  });
});
