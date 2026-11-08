import type { MessageKey } from './i18n/t';

/**
 * R37 · "Connect apps simply" — what a provider's refusal means, in plain words.
 *
 * When Google or Microsoft sends someone back without connecting, the API forwards the provider's
 * error code (only codes on its allowlist) as `reason` in the fragment. This map turns that code
 * into one sentence for the person, and — for the platform owner — one sentence naming the step
 * of the "Set it up" checklist that fixes it. No error code is ever shown on screen.
 */

export type ConnectProvider = 'google' | 'microsoft';

export interface ConnectExplanation {
  /** What everyone sees, with `{provider}`. */
  readonly userKey: MessageKey;
  /** What the platform owner sees, with `{provider}` and `{step}`; `null` when nothing to fix. */
  readonly ownerKey: MessageKey | null;
  /** The checklist step that fixes it (1-based), or `null`. */
  readonly fixStep: number | null;
  /** The platform side is not set up: the card shows "Not available yet" / "Set it up". */
  readonly needsSetup: boolean;
}

/** The checklist steps per provider (see `ConnectSetupGuide`). */
export const SETUP_STEPS: Readonly<Record<ConnectProvider, number>> = { google: 5, microsoft: 4 };

/** Which step fixes each kind of setup problem, per provider. */
const STEP: Readonly<
  Record<ConnectProvider, { audience: number; addresses: number; keys: number; services: number }>
> = {
  google: { audience: 2, addresses: 3, services: 4, keys: 5 },
  // Microsoft has no separate "turn on services" step: registering again from step 1 fixes it.
  microsoft: { audience: 2, addresses: 3, services: 1, keys: 4 },
};

const DECLINED: ConnectExplanation = {
  userKey: 'ConnectApps.why.declined',
  ownerKey: null,
  fixStep: null,
  needsSetup: false,
};

const GENERIC: ConnectExplanation = {
  userKey: 'ConnectApps.why.generic',
  ownerKey: null,
  fixStep: null,
  needsSetup: false,
};

function setup(ownerKey: MessageKey, fixStep: number): ConnectExplanation {
  return { userKey: 'ConnectApps.why.adminNeeded', ownerKey, fixStep, needsSetup: true };
}

/** The plain explanation for a provider's `reason`; unknown or missing reasons get the generic one. */
export function explainConnectFailure(
  provider: ConnectProvider,
  reason: string | null | undefined,
): ConnectExplanation {
  const steps = STEP[provider];
  switch (reason) {
    case 'access_denied':
      return DECLINED;
    case 'consent_required':
    case 'interaction_required':
      return { ...GENERIC, userKey: 'ConnectApps.why.unfinished' };
    case 'admin_policy_enforced':
      return { ...GENERIC, userKey: 'ConnectApps.why.companyBlocked' };
    case 'server_error':
    case 'temporarily_unavailable':
      return { ...GENERIC, userKey: 'ConnectApps.why.busy' };
    case 'redirect_uri_mismatch':
      return setup('ConnectApps.owner.redirect', steps.addresses);
    case 'invalid_request':
      return setup('ConnectApps.owner.request', steps.addresses);
    case 'invalid_client':
    case 'unauthorized_client':
      return setup('ConnectApps.owner.keys', steps.keys);
    case 'org_internal':
      return setup('ConnectApps.owner.internal', steps.audience);
    case 'invalid_scope':
      return setup('ConnectApps.owner.scope', steps.services);
    default:
      return GENERIC;
  }
}

/** The provider's brand name, the same in every language. */
export function providerName(provider: ConnectProvider): string {
  return provider === 'google' ? 'Google' : 'Microsoft';
}
