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

  it('returns to the AI-app consent page with its query, and only that same-origin form (S9)', () => {
    const consent = '/connect/authorize?client_id=https%3A%2F%2Fclaude.ai%2Fm&state=a-b_c.d~';
    expect(safeReturnPath(consent)).toBe(consent);
    expect(signInPathFor('/connect/authorize', consent.slice('/connect/authorize'.length))).toBe(
      `/sign-in?next=${encodeURIComponent(consent)}`,
    );
    for (const next of [
      '/connect/authorize?x=https://evil.example',
      '/connect/authorize?x=1#frag',
      '//connect/authorize?x=1',
      '/connect/authorize/../admin?x=1',
      `/connect/authorize?${'a'.repeat(4001)}`,
    ]) {
      expect(safeReturnPath(next)).toBe('/organizations');
    }
  });
});
