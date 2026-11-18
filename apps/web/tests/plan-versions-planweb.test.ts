import { describe, expect, it } from 'vitest';
import { afterSignUpPath, planFromQuery } from '../src/lib/api/plan-versions';

// PLANWEB: the pricing page's `?plan=` carry through sign-up.
describe('PLANWEB sign-up plan carry', () => {
  it('keeps only a catalog plan id from the URL', () => {
    expect(planFromQuery('studio')).toBe('studio');
    expect(planFromQuery('Studio')).toBeNull();
    expect(planFromQuery('studio&price=0')).toBeNull();
    expect(planFromQuery(null)).toBeNull();
  });

  it('opens the change preview only for an accepted paid plan', () => {
    expect(afterSignUpPath('nile studio', 'business')).toBe(
      '/nile%20studio/billing?change=business',
    );
    expect(afterSignUpPath('nile', 'free')).toBe('/nile/home');
    expect(afterSignUpPath('nile', 'enterprise')).toBe('/nile/home');
    expect(afterSignUpPath('nile', null)).toBe('/nile/home');
  });
});
