'use client';

import { useId, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import { PublicIntro, PublicPage } from './public/PublicSite';
import { browserApiClient } from '../../lib/api/browser-client';
import { submitContact } from '../../lib/api/contact';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useHydrated } from '../../lib/use-hydrated';

/** Mirrors the column bounds in `0062_marketing_leads.sql`, so the client rejects before the API does. */
const MAX_NAME = 200;
const MAX_EMAIL = 254;
const MAX_MESSAGE = 4000;

export interface ContactScreenProps {
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Public site — Contact.** The public contact / lead intake (module 1, x161).
 *
 * The only unauthenticated *write* surface in the public site: a member of the public leaves their
 * name, email and a message, and the API persists a lead. It carries no session and no CSRF token
 * — the API route is `@Public()` — and it never renders anyone else's lead: the response is a bare
 * acknowledgement, so there is nothing to echo.
 *
 * The frame is `PublicPage`, the public site's chrome (skip link, banner, one `<main>`), because a
 * public visitor has no organization and therefore no `AppShell` rail; this screen owns the `<h1>`.
 * Client-side validation mirrors the server's bounds so the common mistakes are caught without a
 * round trip; the server remains the authority and its 400 is rendered verbatim.
 */
export function ContactScreen({ client }: ContactScreenProps) {
  const api = client ?? browserApiClient();
  const hydrated = useHydrated();
  const messageId = useId();
  const messageErrorId = `${messageId}-error`;

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [sent, setSent] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const trimmedMessage = message.trim();

    if (trimmedName === '' || trimmedEmail === '' || trimmedMessage === '') {
      setFailure('Enter your name, email and a message.');
      return;
    }
    if (
      trimmedName.length > MAX_NAME ||
      trimmedEmail.length > MAX_EMAIL ||
      trimmedMessage.length > MAX_MESSAGE
    ) {
      setFailure('One of the fields is too long. Please shorten it and try again.');
      return;
    }

    setSending(true);
    setFailure(undefined);
    try {
      await submitContact(api, {
        name: trimmedName,
        email: trimmedEmail,
        message: trimmedMessage,
      });
      setSent(true);
      setName('');
      setEmail('');
      setMessage('');
    } catch (error) {
      setFailure(describe(error));
    } finally {
      setSending(false);
    }
  }

  return (
    <PublicPage>
      <div className="tm-pub-columns">
        <div className="tm-pub-aside">
          <PublicIntro eyebrow="Contact" title="Contact us">
            <p className="tm-pub-lede tm-pub-lede--md">
              Tell us a little about what you need and we will get back to you by email.
            </p>
          </PublicIntro>
          <p className="tm-pub-btn-row">
            <Link className="tm-pub-btn tm-pub-btn--sm tm-pub-btn--quiet" href="/legal/privacy">
              Privacy
            </Link>
            <Link className="tm-pub-btn tm-pub-btn--sm tm-pub-btn--quiet" href="/support">
              Support
            </Link>
          </p>
        </div>

        <div className="tm-pub-card tm-pub-card--roomy tm-pub-form">
          {sent ? (
            <InlineAlert tone="success" title="Thanks — we have your message" live>
              We will reply to the email address you gave us. You can close this page.
            </InlineAlert>
          ) : null}

          {/*
            `noValidate` for the reason `SignInScreen` gives: this form reports its own validation
            through the design system's affordances rather than the browser's unstyleable bubble.
          */}
          <form className="tm-stack" noValidate onSubmit={submit}>
            <fieldset className="tm-fieldset tm-stack" disabled={!hydrated}>
              <Field
                label="Your name"
                name="name"
                autoComplete="name"
                maxLength={MAX_NAME}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setFailure(undefined);
                }}
                required
              />
              <Field
                label="Work email"
                type="email"
                name="email"
                autoComplete="email"
                inputMode="email"
                dir="ltr"
                maxLength={MAX_EMAIL}
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setFailure(undefined);
                }}
                required
              />

              <div className="tm-field">
                <label className="tm-field__label" htmlFor={messageId}>
                  Message
                  <span className="tm-field__required" aria-hidden="true">
                    *
                  </span>
                </label>
                <textarea
                  id={messageId}
                  name="message"
                  className="tm-field__control"
                  rows={5}
                  maxLength={MAX_MESSAGE}
                  value={message}
                  onChange={(event) => {
                    setMessage(event.target.value);
                    setFailure(undefined);
                  }}
                  required
                  aria-describedby={failure ? messageErrorId : undefined}
                />
              </div>

              {failure ? (
                <InlineAlert tone="danger" title="Could not send your message" live>
                  <span id={messageErrorId}>{failure}</span>
                </InlineAlert>
              ) : null}

              <div className="tm-row">
                <Button
                  type="submit"
                  tone="ink"
                  size="accessible"
                  loading={sending}
                  loadingLabel="Sending"
                >
                  Send message
                </Button>
              </div>
            </fieldset>
          </form>
        </div>
      </div>
    </PublicPage>
  );
}

/**
 * Turn a thrown value into a sentence. `ApiRequestError.message` is rendered verbatim — the API's
 * contact 400 is a shape message with no stored data in it.
 */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'We could not reach the server. Please try again.';
  return 'Something went wrong. Please try again.';
}
