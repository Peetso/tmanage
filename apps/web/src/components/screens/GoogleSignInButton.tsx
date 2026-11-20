'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import {
  fetchGoogleAvailability,
  startGoogle,
  type GoogleStartInput,
} from '../../lib/api/google-auth';
import type { ProviderAvailability } from '../../lib/api/provider-availability';
import { isTransientFailure } from '../../lib/session-check';
import { useProviderAvailability } from './useProviderAvailability';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';

/** Whether "Continue with Google" is configured on the API: null until the first answer. */
export function useGoogleAvailability(api: ApiClient): ProviderAvailability | null {
  return useProviderAvailability(() => fetchGoogleAvailability(api));
}

export interface GoogleSignInButtonProps {
  api: ApiClient;
  /** What the attempt is for; read at click time so a typed workspace name is included. */
  input: () => GoogleStartInput;
}

/**
 * "Continue with Google": the design system's outline `Button` with Google's standard "G" mark
 * (`/brand/google-g.svg`, the unmodified multicolour logo Google's branding guidelines require).
 * Clicking asks the API for Google's authorization URL — the API sets the state/nonce/PKCE
 * cookie — and sends the browser there.
 */
export function GoogleSignInButton({ api, input }: GoogleSignInButtonProps) {
  const t = useT();
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState<'none' | 'refused' | 'unreachable'>('none');

  async function go() {
    setWorking(true);
    setFailed('none');
    try {
      window.location.assign(await startGoogle(api, input()));
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
        loadingLabel={t('google.redirecting')}
        onClick={() => void go()}
      >
        <img src="/brand/google-g.svg" alt="" width={18} height={18} aria-hidden="true" />
        {t('google.continue')}
      </Button>
      {failed === 'none' ? null : (
        <InlineAlert tone={failed === 'unreachable' ? 'warning' : 'danger'} live>
          {t(failed === 'unreachable' ? 'google.error.unreachable' : 'google.error.failed')}
        </InlineAlert>
      )}
    </>
  );
}

const ERROR_KEYS: Record<string, MessageKey> = {
  no_account: 'google.error.noAccount',
  signup_closed: 'google.error.signupClosed',
  email_mismatch: 'google.error.emailMismatch',
  invitation_unusable: 'google.error.invitationUnusable',
  already_linked: 'google.error.alreadyLinked',
  unverified_account: 'google.error.unverifiedAccount',
  unverified: 'google.error.unverified',
  cancelled: 'google.error.cancelled',
  state: 'google.error.state',
};

/** The sentence for `?google_error=<code>`; undefined when there is none. */
export function googleErrorKey(search: string): MessageKey | undefined {
  const code = new URLSearchParams(search).get('google_error');
  if (code === null) return undefined;
  return ERROR_KEYS[code] ?? 'google.error.failed';
}

/**
 * The `?google_error` sentence. An account whose address was never proved cannot take Google
 * (it may have been pre-registered by someone else), so that sentence carries the way forward:
 * sign in with the password, or reset it by email.
 */
export function GoogleErrorMessage({ messageKey }: { readonly messageKey: MessageKey }) {
  const t = useT();
  return (
    <>
      {t(messageKey)}
      {messageKey === 'google.error.unverifiedAccount' ? (
        <>
          {' '}
          <Link href="/recover">{t('google.error.resetPassword')}</Link>
        </>
      ) : null}
    </>
  );
}
