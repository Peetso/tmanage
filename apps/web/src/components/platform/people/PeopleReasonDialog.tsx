'use client';

import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import { ApiRequestError } from '../../../lib/api/errors';
import { useT } from '../../../lib/i18n/use-t';
import {
  PlatformDialog,
  PlatformDialogActions,
  REASON_MAX,
  REASON_MIN,
  platformErrorText,
} from '../shared/ReasonDialog';
import { PLATFORM_ME_QUERY_KEY } from '../shared/usePlatformPermissions';

/**
 * The People dialogs with more than a sentence of body (B2 disable 434:16652, B3 reset two-step
 * 435:16133): a block body (lists, a checkbox), the required reason with the drawn field error
 * "Add a reason — it is saved in the platform audit log", the audit note, Cancel and the action.
 */
export function PeopleReasonDialog({
  eyebrow,
  title,
  body,
  extra,
  confirmLabel,
  destructive = false,
  note,
  onConfirm,
  onClose,
}: {
  eyebrow: string;
  title: ReactNode;
  body: ReactNode;
  /** Controls between the reason and the note (B3's "Also sign her out everywhere"). */
  extra?: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  note: ReactNode;
  onConfirm: (reason: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const fieldRef = useRef<HTMLDivElement>(null);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const trimmed = reason.trim();
  const invalid = trimmed.length < REASON_MIN || trimmed.length > REASON_MAX;

  const action = useMutation({
    mutationFn: () => onConfirm(trimmed),
    onSuccess: () => onClose(),
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
    <PlatformDialog eyebrow={eyebrow} title={title} onClose={onClose}>
      <form className="tm-stack" onSubmit={submit} noValidate>
        <div className="tm-stack tm-stack--tight">{body}</div>
        <div ref={fieldRef}>
          <Field
            label={t('PlatformPeople.reasonRequiredLabel')}
            placeholder={t('PlatformPeople.reasonPlaceholder')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={REASON_MAX}
            required
            {...(tried && invalid ? { error: t('PlatformPeople.reasonMissing') } : {})}
          />
        </div>
        {extra}
        <p className="tm-cc-note">{note}</p>
        {action.isError ? (
          <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
            {platformErrorText(action.error, t)}
          </InlineAlert>
        ) : null}
        <PlatformDialogActions>
          <Button type="button" tone="outline" onClick={onClose}>
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
