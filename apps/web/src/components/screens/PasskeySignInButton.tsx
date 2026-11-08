'use client';

import { useEffect, useState } from 'react';
import { Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { passkeysSupported, signInWithPasskey } from '../../lib/api/passkeys';
import { useTOr } from '../../lib/i18n/use-t-or';

const K = 'PasskeySignIn';

export interface PasskeySignInButtonProps {
  readonly api: ApiClient;
  /** Called once the session cookies are set. */
  readonly onSignedIn: () => void;
}

/**
 * "Sign in with a passkey" (56-22, Figma R42 L1 573:32517 / 573:32529): the design system's
 * outline `Button`. Discoverable credentials, so no email is needed; hidden where the browser
 * has no WebAuthn. A cancelled prompt says nothing; a refusal says only that it did not work.
 */
export function PasskeySignInButton({ api, onSignedIn }: PasskeySignInButtonProps) {
  const tr = useTOr();
  const [supported, setSupported] = useState(false);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => setSupported(passkeysSupported()), []);
  if (!supported) return null;

  async function go() {
    setWorking(true);
    setFailed(false);
    try {
      await signInWithPasskey(api);
      onSignedIn();
    } catch (error) {
      const cancelled =
        (error instanceof Error && error.message === 'passkey_cancelled') ||
        (error instanceof DOMException && error.name === 'NotAllowedError');
      if (!cancelled) setFailed(true);
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
        loadingLabel={tr(`${K}.working`, 'Waiting for your passkey')}
        onClick={() => void go()}
      >
        {tr(`${K}.button`, 'Sign in with a passkey')}
      </Button>
      {failed ? (
        <InlineAlert tone="danger" live>
          {tr(`${K}.failed`, 'That passkey did not work. Try again or use your password.')}
        </InlineAlert>
      ) : null}
    </>
  );
}
