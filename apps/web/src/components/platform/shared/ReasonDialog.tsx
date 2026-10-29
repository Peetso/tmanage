'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import { ApiRequestError, NetworkError } from '../../../lib/api/errors';
import { useT } from '../../../lib/i18n/use-t';
import { PLATFORM_ME_QUERY_KEY } from './usePlatformPermissions';

/** The API's reason bounds (`requireReason` / `optionalReason` in `platform-admin.access.ts`). */
export const REASON_MIN = 5;
export const REASON_MAX = 500;

const SCRIM: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 50,
  display: 'grid',
  placeItems: 'center',
  padding: 'var(--s4)',
  background: 'var(--tm-scrim)',
};

const ACTIONS: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'flex-end',
  gap: 'var(--s3)',
  borderBlockStart: '1px solid var(--tm-border, currentColor)',
  paddingBlockStart: 'var(--s4)',
};

/**
 * The modal frame every Platform admin dialog uses (frames 436:19172, 436:19614): scrim, white
 * card with the overlay shadow, a mono eyebrow, the title, and Escape to close.
 */
export function PlatformDialog({
  eyebrow,
  title,
  width = 560,
  onClose,
  children,
}: {
  eyebrow?: string;
  title: ReactNode;
  width?: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div style={SCRIM}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="tm-cc-card tm-stack"
        style={{
          inlineSize: `min(${width}px, 100%)`,
          maxBlockSize: '92vh',
          overflowY: 'auto',
          boxShadow: 'var(--tm-overlay-shadow)',
        }}
      >
        {eyebrow ? <p className="tm-cc-eyebrow">{eyebrow}</p> : null}
        <h2 id={titleId} className="tm-cc-card__title">
          {title}
        </h2>
        {children}
      </section>
    </div>
  );
}

/** The dialog's action row: Cancel, then the confirm button, at the end. */
export function PlatformDialogActions({ children }: { children: ReactNode }) {
  return <div style={ACTIONS}>{children}</div>;
}

/** One message for an action error: the API's sentence, or a plain fallback. */
export function platformErrorText(error: unknown, t: ReturnType<typeof useT>): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('PlatformShared.noAnswer');
  return t('PlatformShared.genericError');
}

export interface ReasonDialogProps {
  title: ReactNode;
  body?: ReactNode;
  /** Required on the destructive list (SPEC P6); optional elsewhere. */
  reasonRequired: boolean;
  /** Red confirm button. */
  destructive?: boolean;
  confirmLabel: string;
  /** The audit note under the reason; defaults to "Recorded in Platform admin actions." */
  note?: ReactNode;
  eyebrow?: string;
  /** Runs the action with the trimmed reason (`null` when optional and left empty). */
  onConfirm: (reason: string | null) => Promise<unknown>;
  onClose: (done: boolean) => void;
}

/**
 * Confirm a platform action with a reason (frame 436:19614). A required reason that is missing or
 * too short shows the field error on submit instead of disabling the button, as drawn. A lapsed
 * step-up re-opens the step-up form through the `me` query.
 */
export function ReasonDialog({
  title,
  body,
  reasonRequired,
  destructive = false,
  confirmLabel,
  note,
  eyebrow,
  onConfirm,
  onClose,
}: ReasonDialogProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const fieldRef = useRef<HTMLDivElement>(null);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const trimmed = reason.trim();
  const invalid = reasonRequired
    ? trimmed.length < REASON_MIN || trimmed.length > REASON_MAX
    : trimmed.length > 0 && (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX);

  const action = useMutation({
    mutationFn: () => onConfirm(trimmed === '' ? null : trimmed),
    onSuccess: () => onClose(true),
    onError: async (error) => {
      if (error instanceof ApiRequestError && error.code === 'reauthentication_required') {
        await queryClient.invalidateQueries({ queryKey: PLATFORM_ME_QUERY_KEY });
      }
    },
  });

  useEffect(() => {
    fieldRef.current?.querySelector('input')?.focus();
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (invalid) {
      fieldRef.current?.querySelector('input')?.focus();
      return;
    }
    action.mutate();
  }

  return (
    <PlatformDialog
      eyebrow={
        eyebrow ??
        `${t('PlatformShared.platformAdmin')} · ${
          reasonRequired
            ? t('PlatformShared.reasonRequiredTag')
            : t('PlatformShared.reasonOptionalTag')
        }`
      }
      title={title}
      onClose={() => onClose(false)}
    >
      <form className="tm-stack" onSubmit={submit} noValidate>
        {body ? <p className="tm-cc-note">{body}</p> : null}
        <div ref={fieldRef}>
          <Field
            label={
              reasonRequired
                ? t('PlatformShared.reasonRequired')
                : t('PlatformShared.reasonOptional')
            }
            placeholder={t('PlatformShared.reasonPlaceholder')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={REASON_MAX}
            required={reasonRequired}
            {...(tried && invalid ? { error: t('PlatformShared.reasonError') } : {})}
          />
        </div>
        <InlineAlert tone="neutral">{note ?? t('PlatformShared.auditNote')}</InlineAlert>
        {action.isError ? (
          <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
            {platformErrorText(action.error, t)}
          </InlineAlert>
        ) : null}
        <PlatformDialogActions>
          <Button type="button" tone="outline" onClick={() => onClose(false)}>
            {t('PlatformShared.cancel')}
          </Button>
          <Button
            type="submit"
            tone={destructive ? 'destructive' : 'ink'}
            loading={action.isPending}
            loadingLabel={t('PlatformShared.working')}
          >
            {confirmLabel}
          </Button>
        </PlatformDialogActions>
      </form>
    </PlatformDialog>
  );
}
