'use client';

import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, Field, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { sendPlatformPasswordReset } from '../../lib/api/platform-admin';
import type { PlatformPersonView } from '../../lib/api/platform-admin';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';

/** The API refuses a reason shorter than this (`ReasonInput` on the platform-admin controller). */
const MIN_REASON = 5;

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

/**
 * **t1-d — "Reset <name>'s password"**, the operator's dialog on the People screen.
 *
 * The person is signed out everywhere when they spend the link, and the reset is written to the
 * audit log with the operator's reason. The API emails the link and returns no link of its own,
 * so the design's one-time shareable link row is not drawn: it would be a link nobody issued.
 */
export function PasswordResetDialog({
  api,
  person,
  onClose,
}: {
  api: ApiClient;
  person: PlatformPersonView;
  onClose: (sent: boolean) => void;
}) {
  const t = useT();
  const tr = (key: string) => t(key as MessageKey);
  const queryClient = useQueryClient();
  const titleId = useId();
  const reasonRef = useRef<HTMLDivElement>(null);
  const [emailIt, setEmailIt] = useState(true);
  const [reason, setReason] = useState('');
  const name = person.displayName.trim() || person.email;
  // One string per locale with a {name} slot, so neither language needs an empty prefix or suffix.
  const [titleBefore = '', titleAfter = ''] = tr('ResetDialog.title').split('{name}');
  const [bodyBefore = '', bodyAfter = ''] = tr('ResetDialog.body').split('{name}');

  const send = useMutation({
    mutationFn: () => sendPlatformPasswordReset(api, person.id, reason.trim()),
    onError: async (error) => {
      if (error instanceof ApiRequestError && error.code === 'reauthentication_required') {
        await queryClient.invalidateQueries({ queryKey: ['platform', 'me'] });
      }
    },
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
    if (!emailIt || reason.trim().length < MIN_REASON) return;
    send.mutate();
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
          {titleBefore}
          {name}
          {titleAfter}
        </h2>
        {send.isSuccess ? (
          <>
            <InlineAlert tone="success" title={tr('ResetDialog.sentTitle')} live>
              {tr('ResetDialog.sentPrefix')}
              <bdi dir="ltr">{person.email}</bdi>
            </InlineAlert>
            <div style={ACTIONS}>
              <Button type="button" tone="ink" onClick={() => onClose(true)}>
                {tr('ResetDialog.done')}
              </Button>
            </div>
          </>
        ) : (
          <form className="tm-stack" onSubmit={submit} noValidate>
            <p className="tm-cc-note">
              {bodyBefore}
              {name}
              {bodyAfter}
            </p>
            <Checkbox
              label={
                <>
                  {tr('ResetDialog.emailPrefix')}
                  <bdi dir="ltr">{person.email}</bdi>
                </>
              }
              checked={emailIt}
              onChange={(event) => setEmailIt(event.target.checked)}
            />
            <div ref={reasonRef}>
              <Field
                label={tr('ResetDialog.reasonLabel')}
                hint={tr('ResetDialog.reasonHint')}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                minLength={MIN_REASON}
                maxLength={500}
                required
              />
            </div>
            <InlineAlert tone="warning">{tr('ResetDialog.note')}</InlineAlert>
            {send.isError ? (
              <InlineAlert tone="danger" title={tr('ResetDialog.notDone')} live>
                {send.error instanceof ApiRequestError
                  ? send.error.message
                  : send.error instanceof NetworkError
                    ? tr('ResetDialog.noAnswer')
                    : tr('ResetDialog.genericError')}
              </InlineAlert>
            ) : null}
            <div style={ACTIONS}>
              <Button type="button" tone="outline" onClick={() => onClose(false)}>
                {tr('ResetDialog.cancel')}
              </Button>
              <Button
                type="submit"
                tone="ink"
                loading={send.isPending}
                loadingLabel={tr('ResetDialog.sending')}
                disabled={!emailIt || reason.trim().length < MIN_REASON}
              >
                {tr('ResetDialog.send')}
              </Button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
