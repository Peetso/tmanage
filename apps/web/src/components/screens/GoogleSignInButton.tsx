'use client';

import { useEffect, useState } from 'react';
import { Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import {
  fetchGoogleAvailability,
  startGoogle,
  type GoogleAvailabilityView,
  type GoogleStartInput,
} from '../../lib/api/google-auth';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';

/** Whether "Continue with Google" is configured on the API (null while unknown or when not). */
export function useGoogleAvailability(api: ApiClient): GoogleAvailabilityView | null {
  const [availability, setAvailability] = useState<GoogleAvailabilityView | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchGoogleAvailability(api).then((value) => {
      if (!cancelled) setAvailability(value);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return availability;
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
  const [failed, setFailed] = useState(false);

  async function go() {
    setWorking(true);
    setFailed(false);
    try {
      window.location.assign(await startGoogle(api, input()));
    } catch {
      setFailed(true);
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
      {failed ? (
        <InlineAlert tone="danger" live>
          {t('google.error.failed')}
        </InlineAlert>
      ) : null}
    </>
  );
}

const ERROR_KEYS: Record<string, MessageKey> = {
  no_account: 'google.error.noAccount',
  signup_closed: 'google.error.signupClosed',
  email_mismatch: 'google.error.emailMismatch',
  invitation_unusable: 'google.error.invitationUnusable',
  already_linked: 'google.error.alreadyLinked',
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
