'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { ApiRequestError } from '../../../lib/api/errors';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useTOr } from '../../../lib/i18n/use-t-or';
import {
  cancelMagicLink,
  consumeMagicLink,
  previewMagicLink,
  requestMagicLink,
  signInWithMagicCode,
} from './PortalSignInApi';
import '../../../styles/screens/portal-sign-in.css';

/**
 * **55-14 client portal sign-in by e-mail link** — drawn as Figma R43 L1-55-14 (575:33082):
 * request a link, check your e-mail, the link landing, the 6-digit code fallback, "Not you?",
 * an expired or used link, and too many tries. EN and AR (mirrored by `dir`).
 */

/** After this many failed link opens on this browser the code form opens by itself. */
export const FAILED_OPENS_FOR_CODE = 3;
const FAILED_OPENS_KEY = 'tm-portal-sign-in-failed-opens';
const LAST_ORG_KEY = 'tm-portal-sign-in-org';

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function failedOpens(store: Storage | null = storage()): number {
  const value = Number(store?.getItem(FAILED_OPENS_KEY) ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function noteFailedOpen(store: Storage | null = storage()): number {
  const next = failedOpens(store) + 1;
  store?.setItem(FAILED_OPENS_KEY, String(next));
  return next;
}

export function clearFailedOpens(store: Storage | null = storage()): void {
  store?.removeItem(FAILED_OPENS_KEY);
}

/** What a refusal means on these screens, as an i18n key and its English. */
export function refusalLine(error: unknown): readonly [string, string] {
  if (error instanceof ApiRequestError) {
    if (error.status === 429) {
      return ['PortalSignIn.tooManyTries', 'Too many tries. Wait a few minutes and try again.'];
    }
    if (error.status === 409 && error.details.some((d) => d.message === 'signed_in')) {
      return ['PortalSignIn.alreadySignedIn', 'You are already signed in. Sign out first.'];
    }
    if (error.status === 400 && error.fieldErrors().has('code')) {
      return ['PortalSignIn.codeWrong', 'That code is wrong or has expired. Ask for a new link.'];
    }
    if (error.status === 400) {
      return ['PortalSignIn.emailInvalid', 'Enter the e-mail address your team invited.'];
    }
  }
  return ['PortalSignIn.somethingWrong', 'Something went wrong. Try again.'];
}

/** A link that cannot sign anybody in: used, unknown, expired or cancelled. */
export function isDeadLink(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === 404 || error.status === 409)
    ? !error.details.some((d) => d.message === 'signed_in')
    : false;
}

function Card({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <main className="tm-portal-signin">
      <section className="tm-card tm-portal-signin__card" aria-labelledby="tm-portal-signin-title">
        <p className="tm-portal-signin__eyebrow">{eyebrow}</p>
        <h1 id="tm-portal-signin-title" className="tm-portal-signin__title">
          {title}
        </h1>
        {children}
      </section>
    </main>
  );
}

/** Put the e-mail (kept left-to-right) where `{email}` stands in a translated line. */
export function withEmail(line: string, email: string): ReactNode {
  const [before = '', after = ''] = line.split('{email}');
  return (
    <>
      {before}
      <bdi dir="ltr">{email}</bdi>
      {after}
    </>
  );
}

function goTo(path: string): void {
  if (typeof window !== 'undefined') window.location.assign(path);
}

export interface PortalSignInRequestScreenProps {
  readonly orgSlug: string;
  readonly client?: ApiClient;
}

/** `/<org>/portal/sign-in` — ask for a link; then "check your e-mail" and the code fallback. */
export function PortalSignInRequestScreen({ orgSlug, client }: PortalSignInRequestScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const locale = useActiveLocale();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'request' | 'check' | 'code'>('request');
  const portal = `/${encodeURIComponent(orgSlug)}/portal`;
  const eyebrow = tOr('PortalSignIn.eyebrow', 'Client portal');

  const send = useMutation({
    mutationFn: () =>
      requestMagicLink(api, {
        orgSlug,
        email: email.trim(),
        language: locale.startsWith('ar') ? 'ar' : 'en',
      }),
    onSuccess: () => {
      storage()?.setItem(LAST_ORG_KEY, orgSlug);
      setStep(failedOpens() >= FAILED_OPENS_FOR_CODE ? 'code' : 'check');
    },
  });
  const verify = useMutation({
    mutationFn: () => signInWithMagicCode(api, { orgSlug, email: email.trim(), code: code.trim() }),
    onSuccess: () => {
      clearFailedOpens();
      goTo(portal);
    },
  });
  const failure = (error: unknown) => {
    if (error === null) return null;
    const [key, english] = refusalLine(error);
    return (
      <InlineAlert
        tone={error instanceof ApiRequestError && error.status === 429 ? 'warning' : 'danger'}
        live
      >
        {tOr(key, english)}
      </InlineAlert>
    );
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (step === 'code') verify.mutate();
    else send.mutate();
  };

  if (step === 'check') {
    return (
      <Card eyebrow={eyebrow} title={tOr('PortalSignIn.checkTitle', 'Check your e-mail')}>
        <p className="tm-portal-signin__body">
          {withEmail(
            tOr(
              'PortalSignIn.checkBody',
              'If {email} can use this portal, a sign-in link is on its way.',
            ),
            email.trim(),
          )}
        </p>
        {failure(send.error)}
        <Button
          tone="outline"
          size="accessible"
          loading={send.isPending}
          onClick={() => send.mutate()}
        >
          {tOr('PortalSignIn.sendAnother', 'Send another link')}
        </Button>
        <button type="button" className="tm-portal-signin__link" onClick={() => setStep('code')}>
          {tOr('PortalSignIn.useCode', 'Links not opening? Use a 6-digit code')}
        </button>
      </Card>
    );
  }

  const coding = step === 'code';
  return (
    <Card
      eyebrow={eyebrow}
      title={
        coding
          ? tOr('PortalSignIn.codeTitle', 'Enter your 6-digit code')
          : tOr('PortalSignIn.requestTitle', 'Sign in to the client portal')
      }
    >
      <p className="tm-portal-signin__body">
        {coding
          ? withEmail(
              tOr(
                'PortalSignIn.codeBody',
                'Your links did not open three times, so we e-mailed a code to {email}.',
              ),
              email.trim(),
            )
          : tOr(
              'PortalSignIn.requestBody',
              'Enter the e-mail your team invited. We will send you a one-time sign-in link.',
            )}
      </p>
      {failure(coding ? verify.error : send.error)}
      <form className="tm-stack" noValidate onSubmit={submit}>
        <Field
          label={tOr('PortalSignIn.email', 'E-mail')}
          type="email"
          name="email"
          autoComplete="username"
          inputMode="email"
          dir="ltr"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        {coding ? (
          <Field
            label={tOr('PortalSignIn.code', 'Code')}
            name="code"
            autoComplete="one-time-code"
            inputMode="numeric"
            dir="ltr"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/gu, ''))}
            required
          />
        ) : null}
        <Button
          type="submit"
          tone="ink"
          size="accessible"
          loading={coding ? verify.isPending : send.isPending}
        >
          {coding
            ? tOr('PortalSignIn.signIn', 'Sign in')
            : tOr('PortalSignIn.sendLink', 'E-mail me a link')}
        </Button>
      </form>
      <p className="tm-portal-signin__note">
        {coding
          ? tOr('PortalSignIn.codeNote', 'The code works for 10 minutes.')
          : tOr('PortalSignIn.linkNote', 'Links work once and stop working after 15 minutes.')}
      </p>
    </Card>
  );
}

export interface PortalMagicLinkScreenProps {
  readonly token: string;
  /** `?not-you=1` from the mail: show the cancel step first. */
  readonly notYou?: boolean;
  readonly client?: ApiClient;
}

/** `/portal-sign-in/<token>` — the mailed link's page. Opening it signs nobody in; a click does. */
export function PortalMagicLinkScreen({
  token,
  notYou = false,
  client,
}: PortalMagicLinkScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const [cancelled, setCancelled] = useState(false);
  const eyebrow = tOr('PortalSignIn.eyebrow', 'Client portal');
  const lastOrg = storage()?.getItem(LAST_ORG_KEY) ?? null;
  const again = lastOrg === null ? '/sign-in' : `/${encodeURIComponent(lastOrg)}/portal/sign-in`;

  const view = useQuery({
    queryKey: ['portal-magic-link', token],
    queryFn: async () => {
      try {
        const preview = await previewMagicLink(api, token);
        if (preview.state !== 'active') noteFailedOpen();
        return preview;
      } catch (error) {
        if (isDeadLink(error)) noteFailedOpen();
        throw error;
      }
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
  const consume = useMutation({
    mutationFn: () => consumeMagicLink(api, token),
    onSuccess: () => {
      clearFailedOpens();
      const data = view.data;
      goTo(data?.state === 'active' ? `/${encodeURIComponent(data.organizationSlug)}/portal` : '/');
    },
    onError: (error) => {
      if (isDeadLink(error)) noteFailedOpen();
    },
  });
  const cancel = useMutation({
    mutationFn: () => cancelMagicLink(api, token),
    onSuccess: () => setCancelled(true),
  });

  const dead = (
    <Card
      eyebrow={eyebrow}
      title={tOr('PortalSignIn.deadTitle', 'This link can no longer be used')}
    >
      <p className="tm-portal-signin__body">
        {tOr(
          'PortalSignIn.deadBody',
          'Sign-in links work once and stop working after 15 minutes. Ask for a new one.',
        )}
      </p>
      <Button tone="ink" size="accessible" onClick={() => goTo(again)}>
        {tOr('PortalSignIn.newLink', 'Get a new link')}
      </Button>
    </Card>
  );

  if (cancelled) {
    return (
      <Card eyebrow={eyebrow} title={tOr('PortalSignIn.cancelledTitle', 'Link cancelled')}>
        <p className="tm-portal-signin__body">
          {tOr(
            'PortalSignIn.cancelledBody',
            'Nobody can sign in with it now. We let the owner of the address know.',
          )}
        </p>
        <Button tone="outline" size="accessible" onClick={() => goTo(again)}>
          {tOr('PortalSignIn.backToSignIn', 'Back to sign-in')}
        </Button>
      </Card>
    );
  }
  if (view.isPending) {
    return (
      <Card eyebrow={eyebrow} title={tOr('PortalSignIn.opening', 'Opening your link…')}>
        <LoadingRegion label={tOr('PortalSignIn.opening', 'Opening your link…')}>
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      </Card>
    );
  }
  if (view.isError || view.data.state !== 'active' || isDeadLink(consume.error)) {
    if (view.isError && !isDeadLink(view.error)) {
      const [key, english] = refusalLine(view.error);
      return (
        <Card
          eyebrow={eyebrow}
          title={tOr('PortalSignIn.requestTitle', 'Sign in to the client portal')}
        >
          <InlineAlert tone="warning" live>
            {tOr(key, english)}
          </InlineAlert>
        </Card>
      );
    }
    return dead;
  }

  const link = view.data;
  const who = link.audienceHint ?? '';
  if (notYou) {
    return (
      <Card eyebrow={link.organizationName} title={tOr('PortalSignIn.notYouTitle', 'Not you?')}>
        <p className="tm-portal-signin__body">
          {withEmail(
            tOr(
              'PortalSignIn.notYouBody',
              'Someone asked for a sign-in link for {email}. Cancel it if it was not you.',
            ),
            who,
          )}
        </p>
        {cancel.error ? (
          <InlineAlert tone="danger" live>
            {tOr(...refusalLine(cancel.error))}
          </InlineAlert>
        ) : null}
        <Button
          tone="ink"
          size="accessible"
          loading={cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          {tOr('PortalSignIn.cancelLink', 'Cancel this link')}
        </Button>
      </Card>
    );
  }
  return (
    <Card
      eyebrow={link.organizationName}
      title={tOr('PortalSignIn.landingTitle', 'Sign in to the client portal')}
    >
      <p className="tm-portal-signin__body">
        {withEmail(
          tOr('PortalSignIn.landingBody', 'You are signing in as {email}. This link works once.'),
          who,
        )}
      </p>
      {consume.error ? (
        <InlineAlert tone="warning" live>
          {tOr(...refusalLine(consume.error))}
        </InlineAlert>
      ) : null}
      <Button
        tone="ink"
        size="accessible"
        loading={consume.isPending}
        onClick={() => consume.mutate()}
      >
        {tOr('PortalSignIn.signIn', 'Sign in')}
      </Button>
      <button
        type="button"
        className="tm-portal-signin__link"
        disabled={cancel.isPending}
        onClick={() => cancel.mutate()}
      >
        {tOr('PortalSignIn.notYouLink', 'Not you? Cancel this link')}
      </button>
    </Card>
  );
}
