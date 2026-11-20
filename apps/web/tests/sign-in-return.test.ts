import { describe, expect, it } from 'vitest';
import {
  CONFIRM_EMAIL_RETURN,
  SIGN_IN_TO_CONFIRM_EMAIL,
  confirmEmailSettingPath,
  safeReturnPath,
  signInPathFor,
  wantsConfirmEmailSetting,
} from '../src/lib/sign-in-return';

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
      // AUTHSTATE (ENGINEERING-RULES §2.5): same-origin relative paths only, in every spelling.
      '///evil.example',
      'HTTPS://evil.example/platform',
      'javascript:alert(1)',
      'data:text/html,x',
      '\\\\evil.example',
      '/\\evil.example',
      '\\/evil.example',
      '%2F%2Fevil.example',
      '/%2F%2Fevil.example',
      '/%5Cevil.example',
      '/platform/%2F%2Fevil.example',
      '/platform//evil.example',
      '/platform\\evil.example',
      '/platform/..%2F..%2Fevil',
      ' /platform',
      '/platform\n',
      '/platform#//evil.example',
      '/platform?next=//evil.example',
      '/connect/authorize?x=1#//evil.example',
    ]) {
      expect(safeReturnPath(next)).toBe('/organizations');
    }
    expect(signInPathFor('/acme/home')).toBe('/sign-in');
  });

  it('returns to the confirmation-mail setting only by its exact path (CONFIRMPOLISH 2)', () => {
    expect(safeReturnPath(CONFIRM_EMAIL_RETURN)).toBe('/organizations?then=confirm-email');
    expect(SIGN_IN_TO_CONFIRM_EMAIL).toBe('/sign-in?next=%2Forganizations%3Fthen%3Dconfirm-email');
    for (const next of [
      '/organizations?then=confirm-email&next=//evil.example',
      '/organizations?then=//evil.example',
      '//evil.example/organizations?then=confirm-email',
    ]) {
      expect(safeReturnPath(next)).toBe('/organizations');
    }
    expect(wantsConfirmEmailSetting('?then=confirm-email')).toBe(true);
    expect(wantsConfirmEmailSetting('?then=home')).toBe(false);
    expect(confirmEmailSettingPath('acme')).toBe('/acme/settings/two-step#tm-confirm-email');
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
