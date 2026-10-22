'use client';

import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, Checkbox, Field, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { sendMemberPasswordReset } from '../../lib/api/member-password-reset';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';

/** The API refuses a reason shorter than this (422). */
const MIN_REASON = 5;
const MAX_REASON = 500;

const SCRIM: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 50,
  display: 'grid',
  placeItems: 'center',
  padding: 'var(--s4)',
  background: 'var(--tm-scrim)',
};

const PANEL: CSSProperties = {
  inlineSize: 'min(560px, 100%)',
  maxBlockSize: '90vh',
  overflowY: 'auto',
  boxShadow: 'var(--tm-overlay-shadow)',
};

const ACTIONS: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'flex-end',
  gap: 'var(--s3)',
};

/** Replace each `{slot}` in a catalog string, so neither language needs an empty prefix. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/gu, (whole, slot: string) => values[slot] ?? whole);
}

/**
 * **t1-d — "Reset <name>'s password"**, the organization admin's dialog on a person's profile.
 *
 * The API emails the ordinary single-use 30-minute link to the member's own sign-in address and
 * returns no link, so the design's one-time shareable link row is not drawn (P2 does the same),
 * and the email box is checked and fixed. The profile read carries no address, so the label says
 * "to their sign-in address". The reason is required and goes to the audit log's record of the
 * reset. A 403/404 from the API — someone without `org.manage`, or a person in another
 * organization — renders as "not allowed" inside the dialog.
 */
export function MemberPasswordResetDialog({
  api,
  organizationSlug,
  membershipId,
  displayName,
  firstName,
  onClose,
}: {
  api: ApiClient;
  organizationSlug: string;
  membershipId: string;
  displayName: string;
  firstName: string;
  onClose: (sent: boolean) => void;
}) {
  const t = useT();
  const tr = (key: string) => t(key as MessageKey);
  const titleId = useId();
  const reasonRef = useRef<HTMLDivElement>(null);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const slots = { name: displayName, first: firstName };
  const reasonShort = reason.trim().length < MIN_REASON;

  const send = useMutation({
    mutationFn: () => sendMemberPasswordReset(api, organizationSlug, membershipId, reason.trim()),
  });

  useEffect(() => {
    reasonRef.current?.querySelector('input')?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose(send.isSuccess);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, send.isSuccess]);

  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (reasonShort || send.isPending) return;
    send.mutate();
  }

  function errorText(error: unknown): string {
    if (error instanceof ApiRequestError) {
      if (error.status === 403 || error.status === 404) return tr('ResetMemberPassword.notAllowed');
      return error.message;
    }
    if (error instanceof NetworkError) return tr('ResetMemberPassword.noAnswer');
    return tr('ResetMemberPassword.genericError');
  }

  return (
    <div style={SCRIM}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="tm-cc-card"
        style={PANEL}
      >
        <h2 id={titleId} className="tm-cc-card__title">
          {fill(tr('ResetMemberPassword.title'), slots)}
        </h2>
        {send.isSuccess ? (
          <>
            <InlineAlert tone="success" title={tr('ResetMemberPassword.sentTitle')} live>
              {fill(tr('ResetMemberPassword.sentBody'), slots)}
            </InlineAlert>
            <div style={ACTIONS}>
              <Button type="button" tone="ink" onClick={() => onClose(true)}>
                {tr('ResetMemberPassword.done')}
              </Button>
            </div>
          </>
        ) : (
          <form className="tm-stack" onSubmit={submit} noValidate>
            <p className="tm-cc-note">{fill(tr('ResetMemberPassword.lede'), slots)}</p>
            <Checkbox label={tr('ResetMemberPassword.emailLink')} checked disabled readOnly />
            <div ref={reasonRef}>
              <Field
                label={tr('ResetMemberPassword.reasonLabel')}
                hint={tr('ResetMemberPassword.reasonHint')}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                onBlur={() => setTouched(true)}
                error={touched && reasonShort ? tr('ResetMemberPassword.reasonError') : undefined}
                minLength={MIN_REASON}
                maxLength={MAX_REASON}
                required
              />
            </div>
            <InlineAlert tone="warning">{tr('ResetMemberPassword.warning')}</InlineAlert>
            {send.isError ? (
              <InlineAlert tone="danger" title={tr('ResetMemberPassword.notDone')} live>
                {errorText(send.error)}
              </InlineAlert>
            ) : null}
            <div style={ACTIONS}>
              <Button type="button" tone="outline" onClick={() => onClose(false)}>
                {tr('ResetMemberPassword.cancel')}
              </Button>
              <Button
                type="submit"
                tone="ink"
                loading={send.isPending}
                loadingLabel={tr('ResetMemberPassword.sending')}
              >
                {tr('ResetMemberPassword.send')}
              </Button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
