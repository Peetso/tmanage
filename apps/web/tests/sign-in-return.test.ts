import { describe, expect, it } from 'vitest';
import { safeReturnPath, signInPathFor } from '../src/lib/sign-in-return';

/** ACC-01: sign-in brings an invitee back to their invitation, and never anywhere else. */
const INVITE = `/invitations/${'A'.repeat(43)}`;

describe('sign-in return path', () => {
  it('returns to an invitation after sign-in', () => {
    expect(safeReturnPath(INVITE)).toBe(INVITE);
    expect(signInPathFor(INVITE)).toBe(`/sign-in?next=${encodeURIComponent(INVITE)}`);
  });

  it('refuses every other target, so ?next= is never an open redirect', () => {
    for (const next of [
      null,
      undefined,
      '',
      '/organizations/x',
      'https://evil.example/invitations/aaaa',
      '//evil.example',
      `${INVITE}/../../admin`,
      `/invitations/${'A'.repeat(43)}?x=1`,
    ]) {
      expect(safeReturnPath(next)).toBe('/organizations');
    }
    expect(signInPathFor('/acme/home')).toBe('/sign-in');
  });
});
