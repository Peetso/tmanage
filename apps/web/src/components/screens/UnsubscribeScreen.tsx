'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, InlineAlert } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { unsubscribeByToken } from '../../lib/api/email-unsubscribe';
import { ApiRequestError } from '../../lib/api/errors';
import { useT } from '../../lib/i18n/use-t';
import '../../styles/screens/identity.css';

type UnsubscribeState = 'ask' | 'done' | 'invalid';

/**
 * **Unsubscribe from optional e-mails** (PERSONMAIL, ADR-0013).
 *
 * One click stops the optional mail (tips, reminders, notification e-mails) to the address the
 * signed token names. The page says plainly, before and after the click, that sign-in, security
 * and account messages are still sent: the same words as the footer of those mails. "Done" and
 * "invalid" are reached only from the API's answer. Modelled on `ConfirmEmailScreen`.
 */
export function UnsubscribeScreen({ token, client }: { token: string; client?: ApiClient }) {
  const t = useT();
  const api = client ?? browserApiClient();
  const [state, setState] = useState<UnsubscribeState>('ask');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function unsubscribe(): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      await unsubscribeByToken(api, token);
      setState('done');
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 400) setState('invalid');
      else setFailure(t('Unsubscribe.notSent'));
    } finally {
      setBusy(false);
    }
  }

  const settings = (
    <Link className="tm-button tm-button--outline tm-button--accessible" href="/organizations">
      {t('Unsubscribe.settingsLink')}
    </Link>
  );

  return (
    <IdentityShell>
      {state === 'ask' ? (
        <div className="tm-id-bare tm-stack">
          <section className="tm-id-card">
            <h1 className="tm-id-card__title">{t('Unsubscribe.pageTitle')}</h1>
            <p className="tm-id-card__body">{t('Unsubscribe.pageBody')}</p>
            <p className="tm-id-card__body">{t('Unsubscribe.stillSent')}</p>
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
                loadingLabel={t('Unsubscribe.confirm')}
                onClick={() => void unsubscribe()}
              >
                {t('Unsubscribe.confirm')}
              </Button>
              {settings}
            </div>
          </section>
        </div>
      ) : null}

      {state === 'done' ? (
        <div className="tm-id-bare tm-stack">
          <section className="tm-id-card tm-id-card--success">
            <h1 className="tm-id-card__title">{t('Unsubscribe.done')}</h1>
            <InlineAlert tone="success" live>
              {t('Unsubscribe.doneBody')}
            </InlineAlert>
            <p className="tm-id-card__body">{t('Unsubscribe.stillSent')}</p>
            <div className="tm-id-action-row">{settings}</div>
          </section>
        </div>
      ) : null}

      {state === 'invalid' ? (
        <div className="tm-id-bare tm-stack">
          <section className="tm-id-card tm-id-card--warning">
            <h1 className="tm-id-card__title">{t('Unsubscribe.invalid')}</h1>
            <p className="tm-id-card__body">{t('Unsubscribe.invalidBody')}</p>
            <div className="tm-id-action-row">{settings}</div>
          </section>
        </div>
      ) : null}
    </IdentityShell>
  );
}
