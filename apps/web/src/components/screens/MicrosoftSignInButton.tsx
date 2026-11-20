'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import type { GoogleStartInput } from '../../lib/api/google-auth';
import { fetchMicrosoftAvailability, startMicrosoft } from '../../lib/api/microsoft-auth';
import type { ProviderAvailability } from '../../lib/api/provider-availability';
import { isTransientFailure } from '../../lib/session-check';
import { useProviderAvailability } from './useProviderAvailability';
import { useTOr } from '../../lib/i18n/use-t-or';

/** Whether "Continue with Microsoft" is configured on the API: null until the first answer. */
export function useMicrosoftAvailability(api: ApiClient): ProviderAvailability | null {
  return useProviderAvailability(() => fetchMicrosoftAvailability(api));
}

export interface MicrosoftSignInButtonProps {
  api: ApiClient;
  /** What the attempt is for; read at click time so a typed workspace name is included. */
  input: () => GoogleStartInput;
}

/**
 * "Continue with Microsoft" (51-05): the same outline `Button` as "Continue with Google", with
 * Microsoft's unmodified four-square logo (`/brand/microsoft-logo.svg`) as its brand guidelines
 * require. The design file has no Microsoft frame yet, so this mirrors the Google button.
 */
export function MicrosoftSignInButton({ api, input }: MicrosoftSignInButtonProps) {
  const tr = useTOr();
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState<'none' | 'refused' | 'unreachable'>('none');

  async function go() {
    setWorking(true);
    setFailed('none');
    try {
      window.location.assign(await startMicrosoft(api, input()));
    } catch (error) {
      // HT-2: the session check's classifier says whether this was "no answer" (try again).
      setFailed(isTransientFailure(error) ? 'unreachable' : 'refused');
      setWorking(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        tone="outline"
        size="accessible"
        loading={working}
        loadingLabel={tr('microsoft.redirecting', 'Opening Microsoft')}
        onClick={() => void go()}
      >
        <img src="/brand/microsoft-logo.svg" alt="" width={18} height={18} aria-hidden="true" />
        {tr('microsoft.continue', 'Continue with Microsoft')}
      </Button>
      {failed === 'none' ? null : (
        <InlineAlert tone={failed === 'unreachable' ? 'warning' : 'danger'} live>
          {failed === 'unreachable'
            ? tr('microsoft.error.unreachable', UNREACHABLE)
            : tr('microsoft.error.failed', FAILED)}
        </InlineAlert>
      )}
    </>
  );
}

const UNREACHABLE = 'Microsoft sign-in is temporarily unavailable. Try again in a moment.';
const FAILED = 'Microsoft sign-in did not go through. Try again, or use your email and password.';

/** `?microsoft_error=<code>` → catalog key and English line. */
const ERRORS: Record<string, readonly [string, string]> = {
  no_account: [
    'microsoft.error.noAccount',
    'No TManage account uses this Microsoft address yet. Create an account first.',
  ],
  signup_closed: ['microsoft.error.signupClosed', 'New accounts are not open right now.'],
  email_mismatch: [
    'microsoft.error.emailMismatch',
    'This invitation was sent to a different email address. Choose the Microsoft account for the invited address, or use the form below.',
  ],
  invitation_unusable: [
    'microsoft.error.invitationUnusable',
    'This invitation cannot be used any more. Ask whoever invited you for a new link.',
  ],
  already_linked: [
    'microsoft.error.alreadyLinked',
    'This TManage account is already linked to a different Microsoft account. Sign in with your email and password.',
  ],
  unverified_account: [
    'microsoft.error.unverifiedAccount',
    'An account with this email address already exists, but its address has not been confirmed, so Microsoft cannot be used to open it. Sign in with your email and password, or reset the password by email.',
  ],
  unverified: [
    'microsoft.error.unverified',
    'Microsoft could not confirm this email address belongs to you, so it cannot be used to sign in. Use your email and password instead.',
  ],
  method_not_allowed: [
    'microsoft.error.methodNotAllowed',
    'Your workspace does not allow signing in with Microsoft. Use the sign-in method your workspace asks for.',
  ],
  cancelled: ['microsoft.error.cancelled', 'Microsoft sign-in was cancelled.'],
  state: [
    'microsoft.error.state',
    'That Microsoft sign-in expired or was started in another browser. Start again.',
  ],
};

/** The `?microsoft_error` refusal, or undefined when there is none. */
export function microsoftErrorOf(search: string): readonly [string, string] | undefined {
  const code = new URLSearchParams(search).get('microsoft_error');
  if (code === null) return undefined;
  return ERRORS[code] ?? ['microsoft.error.failed', FAILED];
}

/** The refusal sentence; an unconfirmed account also gets the way forward (reset by email). */
export function MicrosoftErrorMessage({ error }: { readonly error: readonly [string, string] }) {
  const tr = useTOr();
  return (
    <>
      {tr(error[0], error[1])}
      {error[0] === 'microsoft.error.unverifiedAccount' ? (
        <>
          {' '}
          <Link href="/recover">{tr('microsoft.error.resetPassword', 'Reset your password')}</Link>
        </>
      ) : null}
    </>
  );
}
