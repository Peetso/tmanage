'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, InlineAlert } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { completeEmailConfirmation } from '../../lib/api/email-confirmation';
import { ApiRequestError } from '../../lib/api/errors';
import { useT } from '../../lib/i18n/use-t';
import '../../styles/screens/identity.css';

type ConfirmState = 'ask' | 'done' | 'expired';

/**
 * **Confirm your e-mail — the link from the confirmation mail** (VERIFYMAIL).
 *
 * The page asks for a click before it spends the link, so a mail scanner that opens the link does
 * not use it up. The token goes straight into a request body and is never rendered. "Done" and
 * "expired" are reached only from the API's answer. Confirming does not sign anyone in.
 */
export function ConfirmEmailScreen({ token, client }: { token: string; client?: ApiClient }) {
  const t = useT();
  const api = client ?? browserApiClient();
  const [state, setState] = useState<ConfirmState>('ask');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function confirm(): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      await completeEmailConfirmation(api, token);
      setState('done');
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) setState('expired');
      else setFailure(t('ConfirmEmail.notSent'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <IdentityShell
      eyebrow={t('ConfirmEmail.pageTitle')}
      footer={<Link href="/sign-in">{t('RecoveryScreen.backToSignIn')}</Link>}
    >
      {state === 'ask' ? (
        <div className="tm-id-bare tm-stack">
          <section className="tm-id-card">
            <h1 className="tm-id-card__title">{t('ConfirmEmail.pageTitle')}</h1>
            <p className="tm-id-card__body">{t('ConfirmEmail.pageBody')}</p>
            {failure ? (
              <InlineAlert tone="danger" title={t('RecoveryScreen.didNotGoThrough')} live>
                {failure}
              </InlineAlert>
            ) : null}
            <div className="tm-id-action-row">
              <Button
                tone="ink"
                size="accessible"
                loading={busy}
                loadingLabel={t('ConfirmEmail.confirm')}
                onClick={() => void confirm()}
              >
                {t('ConfirmEmail.confirm')}
              </Button>
            </div>
          </section>
        </div>
      ) : null}

      {state === 'done' ? (
        <div className="tm-id-bare tm-stack">
          <section className="tm-id-card tm-id-card--success">
            <h1 className="tm-id-card__title">{t('ConfirmEmail.done')}</h1>
            <InlineAlert tone="success" live>
              {t('ConfirmEmail.doneBody')}
            </InlineAlert>
            <div className="tm-id-action-row">
              <Link className="tm-button tm-button--ink tm-button--accessible" href="/sign-in">
                {t('RecoveryScreen.signIn')}
              </Link>
            </div>
          </section>
        </div>
      ) : null}

      {state === 'expired' ? (
        <div className="tm-id-bare tm-stack">
          <section className="tm-id-card tm-id-card--warning">
            <h1 className="tm-id-card__title">{t('RecoveryScreen.linkExpired')}</h1>
            <p className="tm-id-card__body">{t('ConfirmEmail.expired')}</p>
            <div className="tm-id-action-row">
              <Link className="tm-button tm-button--ink tm-button--accessible" href="/sign-in">
                {t('RecoveryScreen.signIn')}
              </Link>
            </div>
          </section>
        </div>
      ) : null}
    </IdentityShell>
  );
}
