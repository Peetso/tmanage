'use client';

import { useState } from 'react';
import { Button, InlineAlert } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import type { ApiClient } from '../../lib/api/client';
import { signOut, type SessionAccount } from '../../lib/api/session';
import type { AuthBoundary } from '../../lib/auth-boundary';
import { useT } from '../../lib/i18n/use-t';
import '../../styles/screens/identity.css';

/**
 * AUTHSTATE: the two screens the shared session check shows instead of a page.
 *
 * Both are the identity card — the wordmark and one card, no app chrome — so nothing of a
 * workspace or of Platform admin is drawn before the API has said who is signed in.
 */

/** "Checking your sign-in…", or "Can't reach TManage — retrying" with a "Try now" button. */
export function SessionStatusCard({
  state,
  onRetry,
}: {
  state: 'checking' | 'unknown';
  onRetry?: () => void;
}) {
  const t = useT();
  return (
    <IdentityShell>
      <div className="tm-id-intro" data-testid="session-status" data-state={state}>
        {state === 'checking' ? (
          <p className="tm-id-lede" role="status">
            {t('SessionGate.checking')}
          </p>
        ) : (
          <InlineAlert tone="warning" title={t('SessionGate.unreachableTitle')} live>
            <p>{t('SessionGate.unreachableBody')}</p>
            {onRetry ? (
              <Button tone="outline" onClick={onRetry}>
                {t('SessionGate.retryNow')}
              </Button>
            ) : null}
          </InlineAlert>
        )}
      </div>
    </IdentityShell>
  );
}

/** "Mona Adel (mona@example.com)", or the e-mail alone when the account has no name. */
export function accountLabel({ displayName, email }: SessionAccount): string {
  const name = displayName.trim();
  return name === '' ? email : `${name} (${email})`;
}

/**
 * "You're signed in as <name (email)>" — the name and e-mail are isolated (`<bdi>`), so a Latin
 * address reads correctly inside Arabic and Urdu sentences. A signed-in visitor sees it on
 * `/sign-in` or `/sign-up` instead of an empty form. Continue goes to `destination` (an allowed `?next=` or their
 * workspace); Sign out ends the session on the server (`DELETE /v1/sessions/current`).
 */
export function SignedInCard({
  account,
  destination,
  client,
  boundary,
  onContinue,
  onSignedOut,
}: {
  account: SessionAccount;
  /** A same-origin path; `undefined` while it is still being worked out. */
  destination: string | undefined;
  client: ApiClient;
  boundary: AuthBoundary;
  onContinue: (destination: string) => void;
  onSignedOut: () => void;
}) {
  const t = useT();
  const [signingOut, setSigningOut] = useState(false);
  const [failed, setFailed] = useState(false);
  const [before = '', after = ''] = t('SessionGate.signedInAs').split('{account}');

  const endSession = async () => {
    setSigningOut(true);
    setFailed(false);
    try {
      await signOut(client);
      // Every cache in every tab is emptied before the form comes back (review finding D01).
      boundary.announce('signed-out');
      onSignedOut();
    } catch {
      setFailed(true);
      setSigningOut(false);
    }
  };

  return (
    <IdentityShell eyebrow={t('SignInScreen.eyebrow')}>
      <div className="tm-id-intro" data-testid="signed-in-card">
        <h1 className="tm-identity__title">{t('SessionGate.signedInTitle')}</h1>
        <p className="tm-id-lede">
          {before}
          <bdi>{accountLabel(account)}</bdi>
          {after}
        </p>
      </div>
      {failed ? (
        <InlineAlert tone="danger" live>
          {t('SessionGate.signOutFailed')}
        </InlineAlert>
      ) : null}
      <div className="tm-id-action-row">
        <Button
          tone="ink"
          size="accessible"
          loading={destination === undefined}
          onClick={() => {
            if (destination !== undefined) onContinue(destination);
          }}
        >
          {t('SessionGate.continue')}
        </Button>
        <Button
          tone="outline"
          size="accessible"
          loading={signingOut}
          loadingLabel={t('SessionGate.signingOut')}
          onClick={() => void endSession()}
        >
          {t('SessionGate.signOut')}
        </Button>
      </div>
    </IdentityShell>
  );
}
