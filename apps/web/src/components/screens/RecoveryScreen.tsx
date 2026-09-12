'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { BackendPending } from './BackendPending';

/** The four states the export draws for recovery, and `22` §3 implies for ID-05. */
export type RecoveryState = 'request' | 'sent' | 'expired' | 'completed';

export interface RecoveryScreenProps {
  /**
   * Which state to render. Only a caller holding a real result may ask for `sent` or
   * `completed`; `/recover` passes nothing, because a URL is not a result (D15).
   */
  state?: RecoveryState;
}

/**
 * **ID-05 Session and recovery** — the recovery half.
 *
 * Four states, drawn as four states rather than as one screen that changes its mind:
 * request, sent, expired, completed.
 *
 * ## The rule that shapes every word here
 *
 * The "sent" state says *"If an account exists for that address, a link is on its way."*
 * That phrasing is not politeness. A recovery form that confirms an address is known is an
 * account-enumeration oracle, and `26-THREAT-MODELS` treats enumeration of the customer base
 * as a real threat for this product because the identifiers are company names and work
 * addresses. So the response is identical whether or not the address is known, and the copy
 * says so plainly instead of implying a lookup happened.
 *
 * The "expired" state refuses to extend the link and explains why in one sentence. Extending
 * a recovery link on request turns a 30-minute window into an indefinite one for anyone who
 * can reach the inbox later.
 *
 * Nothing here sends anything. ID-002 owns password recovery.
 *
 * ## D15 — where `sent` and `completed` may come from
 *
 * `sent` and `completed` assert outcomes: that an email went out, that other sessions were
 * ended, that an audit row was written. Until 2026-09-12 `/recover` reached them from `?state=`,
 * so anyone who could type a URL could make this screen state all three. The 2026-09-05 review
 * recorded that as **D15 · P2** and `apps/web/src/app/recover/page.tsx` no longer reads the
 * parameter — it passes no `state` at all, so the default below applies and the route can only
 * ever render `request`.
 *
 * The two asserting branches survive because `41` line 36 approves all four states for ID-05 and
 * the design must stay reviewable. They are reachable only from a caller holding a real result,
 * and there is no such caller yet: ID-002 owns the operation that would produce one. So while it
 * is unbuilt both branches carry the same `BackendPending` notice `request` does, naming ID-002
 * and denying each claim in turn. The approved copy is untouched; what changed is that it can no
 * longer be read as a report of something that happened. When ID-002 lands, the notice comes off
 * the state its operation substantiates — and not before.
 */
export function RecoveryScreen({ state = 'request' }: RecoveryScreenProps) {
  const [email, setEmail] = useState('');

  return (
    <IdentityShell
      screenId="ID-05"
      eyebrow="Recovery"
      footer={<Link href="/sign-in">Back to sign in</Link>}
    >
      {state === 'request' ? (
        <>
          <div className="tm-stack tm-stack--tight">
            <h1 className="tm-identity__title">Recover access</h1>
            <p className="tm-prose">
              We will send a link to your work email. It works once and expires in 30 minutes.
            </p>
          </div>

          <BackendPending ticket="ID-002">
            No recovery email is sent. The form below does not submit anywhere.
          </BackendPending>

          <form className="tm-stack" onSubmit={(event) => event.preventDefault()}>
            <Field
              label="Work email"
              type="email"
              name="email"
              autoComplete="username"
              inputMode="email"
              dir="ltr"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled
            />
            <div className="tm-row">
              <Button type="submit" tone="ink" size="accessible" disabled>
                Send a recovery link
              </Button>
            </div>
          </form>
        </>
      ) : null}

      {state === 'sent' ? (
        <>
          <div className="tm-stack tm-stack--tight">
            <h1 className="tm-identity__title">Check your email</h1>
          </div>

          <BackendPending ticket="ID-002">
            No recovery email was sent. Nothing in this application dispatches one yet, so the
            wording below is the designed state and not a report of a delivery.
          </BackendPending>

          <InlineAlert tone="neutral" title="A link may be on its way">
            If an account exists for that address, a link is on its way. The link works once and
            expires in 30 minutes.
          </InlineAlert>
          <p className="tm-prose">
            We do not say whether an account exists for an address. That is deliberate: it would let
            anyone check who uses TManage.
          </p>
        </>
      ) : null}

      {/*
        The last branch that makes a claim with no caveat beside it: "That link has expired" is a
        statement about a link this application never issued. It is not part of D15 — the route
        cannot reach it, so nobody is told it — and it is left alone rather than papered over.
        When ID-002 lands, this is the branch to decide about: either a real expiry substantiates
        it, or it needs the same `BackendPending` notice `sent` and `completed` now carry.
      */}
      {state === 'expired' ? (
        <>
          <div className="tm-stack tm-stack--tight">
            <h1 className="tm-identity__title">That link has expired</h1>
          </div>
          <InlineAlert tone="warning" title="Recovery links are never extended">
            For safety we do not extend recovery links. Request a new one — it takes a few seconds.
          </InlineAlert>
          <div className="tm-row">
            <Button tone="ink" size="accessible" disabled>
              Request a new link
            </Button>
          </div>
        </>
      ) : null}

      {state === 'completed' ? (
        <>
          <div className="tm-stack tm-stack--tight">
            <h1 className="tm-identity__title">Access restored</h1>
          </div>

          <BackendPending ticket="ID-002">
            No recovery has run. No access was restored, no session was signed out and no audit row
            was written. This is the designed state, drawn for review — not a result.
          </BackendPending>

          <InlineAlert tone="success" title="Your other sessions were signed out">
            The event was written to the audit log. Set up a passkey to avoid this next time.
          </InlineAlert>
          <div className="tm-row">
            <Button tone="ink" size="accessible" disabled>
              Set up a passkey
            </Button>
          </div>
        </>
      ) : null}
    </IdentityShell>
  );
}
