'use client';

import { useState, type FormEvent } from 'react';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import { browserApiClient } from '../../../../lib/api/browser-client';
import type { ApiClient } from '../../../../lib/api/client';
import { submitContact } from '../../../../lib/api/contact';
import { ApiRequestError, NetworkError } from '../../../../lib/api/errors';
import { useTOr } from '../../../../lib/i18n/use-t-or';
import { integrationRequestMessage } from './integrations-data';

const MAX_NAME = 200;
const MAX_EMAIL = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const K = 'IntegrationsPage.truth.';

export interface IntegrationRequestProps {
  integrationId: string;
  integrationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * 54-02 "Tell us you need it" on a Planned card. The text button opens a two-field request (name,
 * work email) that posts to the existing public contact endpoint as a lead tagged
 * `integration_request:<id>` — no new API surface, the contact form's consent applies.
 */
export function IntegrationRequest({
  integrationId,
  integrationName,
  client,
}: IntegrationRequestProps) {
  const tOr = useTOr();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [sent, setSent] = useState(false);

  if (sent) {
    return (
      <InlineAlert tone="success" title={tOr(`${K}requestDoneTitle`, 'Thank you.')} live>
        {tOr(`${K}requestDoneBody`, 'We will let you know when it ships.')}
      </InlineAlert>
    );
  }

  if (!open) {
    return (
      <Button tone="text" size="feature" onClick={() => setOpen(true)}>
        {tOr(`${K}requestButton`, 'Tell us you need it')}
      </Button>
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanName = name.trim();
    const cleanEmail = email.trim();
    if (cleanName === '' || cleanEmail === '') {
      setFailure(tOr(`${K}requestErrorRequired`, 'Enter your name and work email.'));
      return;
    }
    if (!EMAIL_SHAPE.test(cleanEmail)) {
      setFailure(tOr(`${K}requestErrorEmail`, 'Enter a valid email address.'));
      return;
    }
    setSending(true);
    setFailure(undefined);
    try {
      await submitContact(client ?? browserApiClient(), {
        name: cleanName,
        email: cleanEmail,
        message: integrationRequestMessage(integrationId),
      });
      setSent(true);
    } catch (error) {
      setFailure(
        error instanceof ApiRequestError && error.status === 429
          ? tOr(`${K}requestErrorRateLimited`, 'Too many requests. Try again later.')
          : error instanceof NetworkError
            ? tOr(`${K}requestErrorNetwork`, 'We could not reach TManage. Try again.')
            : tOr(`${K}requestErrorGeneric`, 'Something went wrong. Try again.'),
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      noValidate
      className="tm-web-int-request"
      onSubmit={submit}
      aria-label={`${tOr(`${K}requestButton`, 'Tell us you need it')} · ${integrationName}`}
    >
      <Field
        label={tOr(`${K}requestName`, 'Full name')}
        name="name"
        autoComplete="name"
        maxLength={MAX_NAME}
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
      />
      <Field
        label={tOr(`${K}requestEmail`, 'Work email')}
        type="email"
        name="email"
        autoComplete="email"
        inputMode="email"
        dir="ltr"
        maxLength={MAX_EMAIL}
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        required
      />
      {failure ? (
        <InlineAlert tone="danger" title={tOr(`${K}requestFailureTitle`, 'Not sent')} live>
          {failure}
        </InlineAlert>
      ) : null}
      <Button
        type="submit"
        tone="ink"
        loading={sending}
        loadingLabel={tOr(`${K}requestSending`, 'Sending')}
      >
        {tOr(`${K}requestSend`, 'Send')}
      </Button>
    </form>
  );
}
