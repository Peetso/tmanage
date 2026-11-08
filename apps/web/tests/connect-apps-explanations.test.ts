import { describe, expect, it } from 'vitest';
import en from '../src/lib/i18n/messages/en.json';
import {
  explainConnectFailure,
  SETUP_STEPS,
  type ConnectProvider,
} from '../src/lib/connect-apps-explanations';

const catalog = en as Record<string, string>;

describe('R37 explainConnectFailure — a provider refusal in plain words', () => {
  it('sends setup problems to the owner with the step that fixes them', () => {
    expect(explainConnectFailure('google', 'redirect_uri_mismatch')).toEqual({
      userKey: 'ConnectApps.why.adminNeeded',
      ownerKey: 'ConnectApps.owner.redirect',
      fixStep: 3,
      needsSetup: true,
    });
    expect(explainConnectFailure('google', 'invalid_request').fixStep).toBe(3);
    expect(explainConnectFailure('google', 'invalid_client').fixStep).toBe(5);
    expect(explainConnectFailure('microsoft', 'unauthorized_client').fixStep).toBe(4);
    expect(explainConnectFailure('google', 'org_internal')).toMatchObject({
      ownerKey: 'ConnectApps.owner.internal',
      fixStep: 2,
      needsSetup: true,
    });
  });

  it('treats a person saying no, or a busy provider, as nothing to set up', () => {
    expect(explainConnectFailure('google', 'access_denied')).toMatchObject({
      userKey: 'ConnectApps.why.declined',
      ownerKey: null,
      needsSetup: false,
    });
    expect(explainConnectFailure('microsoft', 'temporarily_unavailable').userKey).toBe(
      'ConnectApps.why.busy',
    );
    expect(explainConnectFailure('google', 'admin_policy_enforced').userKey).toBe(
      'ConnectApps.why.companyBlocked',
    );
  });

  it('never surfaces an unknown code — it falls back to the generic sentence', () => {
    for (const reason of [null, undefined, 'weird_code', '<script>']) {
      expect(explainConnectFailure('google', reason)).toMatchObject({
        userKey: 'ConnectApps.why.generic',
        needsSetup: false,
      });
    }
  });

  it('every explanation exists in English, and every fix step is a real checklist step', () => {
    const reasons = [
      'access_denied',
      'consent_required',
      'admin_policy_enforced',
      'server_error',
      'redirect_uri_mismatch',
      'invalid_request',
      'invalid_client',
      'org_internal',
      'invalid_scope',
      null,
    ];
    for (const provider of ['google', 'microsoft'] as ConnectProvider[]) {
      for (const reason of reasons) {
        const why = explainConnectFailure(provider, reason);
        expect(catalog[why.userKey], why.userKey).toBeTruthy();
        if (why.ownerKey) expect(catalog[why.ownerKey], why.ownerKey).toBeTruthy();
        if (why.fixStep !== null) {
          expect(why.fixStep).toBeGreaterThanOrEqual(1);
          expect(why.fixStep).toBeLessThanOrEqual(SETUP_STEPS[provider]);
        }
      }
    }
  });
});
