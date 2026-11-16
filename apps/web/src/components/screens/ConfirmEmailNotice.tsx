'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import {
  requestEmailConfirmation,
  type EmailConfirmationRequestedView,
} from '../../lib/api/email-confirmation';
import { useT } from '../../lib/i18n/use-t';

/**
 * **"Confirm your e-mail" — the notice on Two-step sign-in** (VERIFYMAIL).
 *
 * Shown while the account's address is not confirmed. The button mails a new link to the
 * person's own address; the API bounds how often (three an hour), and a refused or failed send
 * reads as "try again later". E-mail codes and Platform admin both wait for this confirmation.
 */
export function ConfirmEmailNotice({ api }: { api: ApiClient }) {
  const t = useT();
  const [answer, setAnswer] = useState<EmailConfirmationRequestedView['status'] | 'failed' | null>(
    null,
  );
  const send = useMutation({
    mutationFn: () => requestEmailConfirmation(api),
    onSuccess: (view) => setAnswer(view.status),
    onError: () => setAnswer('failed'),
  });

  let outcome = null;
  if (answer === 'sent') {
    outcome = (
      <InlineAlert tone="success" live>
        {t('ConfirmEmail.sent')}
      </InlineAlert>
    );
  } else if (answer === 'already_confirmed') {
    outcome = (
      <InlineAlert tone="success" live>
        {t('ConfirmEmail.already')}
      </InlineAlert>
    );
  } else if (answer !== null) {
    outcome = (
      <InlineAlert tone="danger" live>
        {t('ConfirmEmail.notSent')}
      </InlineAlert>
    );
  }

  return (
    <section className="tm-sec-card" aria-labelledby="tm-confirm-email">
      <h2 id="tm-confirm-email" className="tm-sec-card__title">
        {t('ConfirmEmail.noticeTitle')}
      </h2>
      <p className="tm-sec-card__body">{t('ConfirmEmail.noticeBody')}</p>
      {outcome}
      <div className="tm-sec-actions">
        <Button
          tone="ink"
          size="feature"
          loading={send.isPending}
          loadingLabel={t('ConfirmEmail.send')}
          disabled={answer === 'sent' || answer === 'already_confirmed'}
          onClick={() => send.mutate()}
        >
          {t('ConfirmEmail.send')}
        </Button>
      </div>
    </section>
  );
}
