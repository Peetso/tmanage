import { describe, expect, it } from 'vitest';
import { statusLabel } from '../src/components/screens/PortalMilestonesScreen';

// B7: an open stage says whether its date is agreed, never "Planned" beside "Committed for".
describe('portal timeline status wording (B7)', () => {
  const t = ((key: string) => key) as Parameters<typeof statusLabel>[1];
  const tOr = (_key: string, english: string) => english;

  it('labels an open stage by whether a date is agreed', () => {
    expect(statusLabel({ status: 'planned', dueOn: '2026-12-01' }, t, tOr)).toBe('Date agreed');
    expect(statusLabel({ status: 'planned', dueOn: null }, t, tOr)).toBe('No date yet');
  });
});
