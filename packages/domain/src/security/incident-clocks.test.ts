import { describe, expect, it } from 'vitest';
import { canResolve, clockStatus, notificationDeadlines } from './incident-clocks.js';

const DETECTED = new Date('2026-11-02T10:00:00.000Z');
const plus = (hours: number) => new Date(DETECTED.getTime() + hours * 3_600_000).toISOString();

describe('notificationDeadlines', () => {
  it('starts a 72-hour authority clock per jurisdiction (SA, EG, EU via a member state, AE)', () => {
    const result = notificationDeadlines({
      detectedAt: DETECTED,
      countries: ['eg', 'DE', 'SA', 'AE', 'US'],
      personalData: true,
      severity: 'SEV1',
    });
    expect(result.authority.map((a) => [a.jurisdiction, a.dueAt.toISOString()])).toEqual([
      ['EU', plus(72)],
      ['SA', plus(72)],
      ['AE', plus(72)],
      ['EG', plus(72)],
    ]);
    expect(result.authority.every((a) => a.basis.length > 0)).toBe(true);
    expect(result.customersDueAt?.toISOString()).toBe(plus(48));
    expect(result.subjectsWithoutUndueDelay).toBe(true);
  });

  it('starts no clock when no personal data is involved', () => {
    expect(
      notificationDeadlines({ detectedAt: DETECTED, countries: ['SA', 'FR'], personalData: false }),
    ).toEqual({ authority: [], customersDueAt: null, subjectsWithoutUndueDelay: false });
  });
});

describe('clockStatus', () => {
  const due = new Date(plus(72));
  it('is ok, due_soon inside 12 h, overdue after, and ok once answered', () => {
    expect(clockStatus(due, new Date(plus(1)))).toBe('ok');
    expect(clockStatus(due, new Date(plus(61)))).toBe('due_soon');
    expect(clockStatus(due, new Date(plus(73)))).toBe('overdue');
    expect(clockStatus(due, new Date(plus(73)), new Date(plus(70)))).toBe('ok');
  });
});

describe('canResolve', () => {
  const open = {
    severity: 'SEV0' as const,
    personalData: true,
    countries: ['SA'],
    notifiedCustomersAt: null,
    notifiedAuthorityAt: null,
  };
  it('refuses a SEV0 with personal data while a clock is open', () => {
    expect(canResolve(open)).toEqual({
      ok: false,
      missing: ['customers_not_notified', 'authority_not_notified'],
    });
    expect(canResolve({ ...open, notifiedCustomersAt: DETECTED })).toEqual({
      ok: false,
      missing: ['authority_not_notified'],
    });
  });
  it('allows it with both notices, or the customer notice and a stated reason', () => {
    expect(
      canResolve({ ...open, notifiedCustomersAt: DETECTED, notifiedAuthorityAt: DETECTED }).ok,
    ).toBe(true);
    expect(canResolve({ ...open, notifiedCustomersAt: DETECTED }, 'encrypted, key safe').ok).toBe(
      true,
    );
    expect(canResolve({ ...open, severity: 'SEV2' }).ok).toBe(true);
  });
});
