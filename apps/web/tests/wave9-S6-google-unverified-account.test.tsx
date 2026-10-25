import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GoogleErrorMessage, googleErrorKey } from '../src/components/screens/GoogleSignInButton';

/**
 * Wave 9 S6, audit run 1 F03: the API refuses to merge Google into an account whose address was
 * never proved and sends the person back with `?google_error=unverified_account`. The sign-in,
 * sign-up and invitation screens must explain that (not the generic "did not go through") and
 * offer the password reset.
 */
describe('google_error=unverified_account (F03)', () => {
  it('maps to its own sentence, not the generic failure', () => {
    expect(googleErrorKey('?google_error=unverified_account')).toBe(
      'google.error.unverifiedAccount',
    );
    expect(googleErrorKey('?google_error=unverified_account')).not.toBe('google.error.failed');
  });

  it('offers the password reset next to the sentence', () => {
    render(<GoogleErrorMessage messageKey="google.error.unverifiedAccount" />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('/recover');
  });

  it('adds no link to the other Google errors', () => {
    render(<GoogleErrorMessage messageKey="google.error.cancelled" />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
