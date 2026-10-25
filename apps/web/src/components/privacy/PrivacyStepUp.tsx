'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import { PrivacyDialog } from './PrivacyDialog';

/**
 * S13 / F28 — "Confirm it's you" before an export or a deletion request.
 *
 * The API answers those requests 403 `reauthentication_required` unless they carry a fresh proof
 * bound to this session. The screen keeps the request it was making, asks for the password (and
 * the two-step code, when one is on), takes the token `POST /v1/auth/reauth` returns, and makes the
 * same request again with it. The token lasts five minutes, so a second act soon after needs no
 * second prompt.
 */

type Tr = (key: string, english: string) => string;

/** Whether a refused write was the step-up refusal, which the step-up dialog answers. */
export function isStepUpRefusal(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === 'reauthentication_required';
}

export interface PrivacyStepUp {
  /** The proof to send with the next request, if one was confirmed. */
  readonly token: () => string | undefined;
  /** On a step-up refusal: forget the old proof and ask for a new one, then run `again`. */
  readonly ask: (error: unknown, again: () => void) => void;
  readonly open: boolean;
  readonly confirmed: (token: string) => void;
  readonly cancel: () => void;
}

export function usePrivacyStepUp(): PrivacyStepUp {
  const proof = useRef<string | null>(null);
  const [retry, setRetry] = useState<{ readonly run: () => void } | null>(null);
  const token = useCallback(() => proof.current ?? undefined, []);
  const ask = useCallback((error: unknown, again: () => void) => {
    if (!isStepUpRefusal(error)) return;
    proof.current = null;
    setRetry({ run: again });
  }, []);
  const confirmed = useCallback(
    (fresh: string) => {
      proof.current = fresh;
      const pending = retry;
      setRetry(null);
      pending?.run();
    },
    [retry],
  );
  const cancel = useCallback(() => setRetry(null), []);
  return { token, ask, open: retry !== null, confirmed, cancel };
}

function stepUpErrorText(tr: Tr, error: unknown): string {
  if (error instanceof ApiRequestError && error.status === 401) {
    return tr('PrivacyStepUp.errorWrong', 'That password or code is not right.');
  }
  if (error instanceof ApiRequestError && error.status === 429) {
    return tr('PrivacyStepUp.errorTooMany', 'Too many tries. Wait a few minutes and try again.');
  }
  return tr('PrivacyStepUp.errorGeneric', 'That did not go through. Try again.');
}

export function PrivacyStepUpDialog({
  api,
  tr,
  onConfirmed,
  onClose,
}: {
  api: ApiClient;
  tr: Tr;
  onConfirmed: (token: string) => void;
  onClose: () => void;
}) {
  const formId = useId();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const confirm = useMutation({
    mutationFn: async () => {
      const digits = code.replace(/\D/gu, '');
      return (
        await api.request<{ reauthToken: string }>({
          method: 'POST',
          path: '/v1/auth/reauth',
          body: digits === '' ? { password } : { password, code: digits },
        })
      ).data;
    },
    onSuccess: (data) => onConfirmed(data.reauthToken),
  });

  return (
    <PrivacyDialog
      title={tr('PrivacyStepUp.title', 'Confirm it’s you')}
      lede={tr(
        'PrivacyStepUp.lede',
        'Enter your password to go on. If two-step sign-in is on, add the code from your app.',
      )}
      onClose={onClose}
      actions={
        <>
          <Button tone="outline" onClick={onClose}>
            {tr('PrivacyStepUp.cancel', 'Cancel')}
          </Button>
          <Button
            tone="ink"
            type="submit"
            form={formId}
            disabled={password === ''}
            loading={confirm.isPending}
            loadingLabel={tr('PrivacyStepUp.confirming', 'Checking')}
          >
            {tr('PrivacyStepUp.confirm', 'Confirm')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          if (password !== '') confirm.mutate();
        }}
      >
        <label className="prv-field">
          <span className="prv-field__label">{tr('PrivacyStepUp.password', 'Password')}</span>
          <input
            className="prv-field__control"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            required
          />
        </label>
        <label className="prv-field">
          <span className="prv-field__label">
            {tr('PrivacyStepUp.code', 'Two-step code, if you use one')}
          </span>
          <input
            className="prv-field__control"
            dir="ltr"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            value={code}
            onChange={(event) => setCode(event.currentTarget.value)}
          />
        </label>
      </form>
      <InlineAlert tone="neutral">
        {tr(
          'PrivacyStepUp.noPassword',
          'No password yet because you sign in with Google? Set one in Preferences › Sign-in, then come back.',
        )}
      </InlineAlert>
      {confirm.isError ? (
        <InlineAlert tone="danger">{stepUpErrorText(tr, confirm.error)}</InlineAlert>
      ) : null}
    </PrivacyDialog>
  );
}
