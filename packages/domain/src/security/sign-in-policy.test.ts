import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIGN_IN_POLICY,
  evaluateSignIn,
  isTwoStepTightened,
  parseSignInPolicy,
  twoStepGraceUntil,
  twoStepRequiredFor,
  validateSignInPolicyPatch,
} from './sign-in-policy.js';
import type { SignInPolicy } from './sign-in-policy.js';

const NOW = new Date('2026-11-02T10:00:00.000Z');
const googleOnly: SignInPolicy = { ...DEFAULT_SIGN_IN_POLICY, allowedMethods: ['google'] };

describe('sign-in policy', () => {
  it('parses defaults from an empty or malformed document and reads the stored keys', () => {
    expect(parseSignInPolicy(null)).toEqual(DEFAULT_SIGN_IN_POLICY);
    expect(parseSignInPolicy('{bad')).toEqual(DEFAULT_SIGN_IN_POLICY);
    expect(
      parseSignInPolicy({
        'signin.allowed_methods': ['google', 'password', 'google'],
        'security.require_two_step_roles': 'admins',
        'security.two_step_grace_until': '2026-11-16T10:00:00.000Z',
      }),
    ).toEqual({
      allowedMethods: ['password', 'google'],
      requireTwoStepRoles: 'admins',
      graceUntil: '2026-11-16T10:00:00.000Z',
    });
  });

  it('refuses a method the policy does not allow, names what to use, and exempts owners', () => {
    expect(evaluateSignIn({ policy: googleOnly, method: 'password', isOwner: false })).toEqual({
      ok: false,
      reason: 'method_not_allowed',
      use: ['google'],
    });
    expect(evaluateSignIn({ policy: googleOnly, method: 'google', isOwner: false }).ok).toBe(true);
    expect(evaluateSignIn({ policy: googleOnly, method: 'password', isOwner: true }).ok).toBe(true);
  });

  it('requires two-step of admins or everyone, with grace, owners warned only', () => {
    const admins: SignInPolicy = { ...DEFAULT_SIGN_IN_POLICY, requireTwoStepRoles: 'admins' };
    const base = { roleKey: 'member', isOwner: false, hasSecondFactor: false, now: NOW };
    expect(twoStepRequiredFor({ ...base, policy: admins })).toBe(false);
    expect(twoStepRequiredFor({ ...base, policy: admins, roleKey: 'org_admin' })).toBe('required');
    const everyone: SignInPolicy = {
      ...DEFAULT_SIGN_IN_POLICY,
      requireTwoStepRoles: 'everyone',
      graceUntil: twoStepGraceUntil(NOW),
    };
    expect(twoStepRequiredFor({ ...base, policy: everyone })).toBe('grace');
    expect(
      twoStepRequiredFor({ ...base, policy: everyone, now: new Date(NOW.getTime() + 15 * 864e5) }),
    ).toBe('required');
    expect(twoStepRequiredFor({ ...base, policy: everyone, roleKey: 'client_viewer' })).toBe(false);
    expect(twoStepRequiredFor({ ...base, policy: everyone, hasSecondFactor: true })).toBe(false);
    expect(twoStepRequiredFor({ ...base, policy: admins, roleKey: 'owner', isOwner: true })).toBe(
      'grace',
    );
  });

  it('validates the PUT body: at least one method, a known scope; tightening is ordered', () => {
    expect(
      validateSignInPolicyPatch({ allowedMethods: [], requireTwoStepRoles: 'nobody' }),
    ).toMatchObject({ ok: false, field: 'allowedMethods' });
    expect(
      validateSignInPolicyPatch({ allowedMethods: ['google'], requireTwoStepRoles: 'all' }),
    ).toMatchObject({ ok: false, field: 'requireTwoStepRoles' });
    expect(isTwoStepTightened('nobody', 'admins')).toBe(true);
    expect(isTwoStepTightened('everyone', 'admins')).toBe(false);
  });
});
