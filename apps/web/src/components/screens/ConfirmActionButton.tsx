'use client';

import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Button, InlineAlert } from '@tmanage/ui';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { ApiRequestError } from '../../lib/api/errors';
import { useTOr } from '../../lib/i18n/use-t-or';
import { WorkDialogFrame } from '../work/DueDatePicker';

export interface ConfirmActionButtonProps {
  /** The words on the button that opens the dialog. */
  readonly triggerLabel: string;
  /** A fuller name for screen readers when the button sits in a list ("Delete label Urgent"). */
  readonly triggerAccessibleLabel?: string;
  /** The dialog's question, e.g. "Delete “Website”?". */
  readonly title: string;
  /** What will happen, in plain words. */
  readonly body: ReactNode;
  readonly confirmLabel: string;
  readonly busyLabel: string;
  /** The alert title when the server says no ("Not deleted"). */
  readonly failedTitle: string;
  /** `destructive` for a delete; `ink` for a change that can be undone (archive, rename). */
  readonly tone?: 'destructive' | 'ink';
  /** Extra fields inside the dialog (the rename box). Enter in them confirms. */
  readonly children?: ReactNode;
  /** The confirm button is off while the fields are not ready. */
  readonly confirmDisabled?: boolean;
  /** Called when the dialog opens, to reset the fields. */
  readonly onOpen?: () => void;
  /** The request. A throw keeps the dialog open and shows why. */
  readonly onConfirm: () => Promise<void>;
  /** After a success, once the dialog has closed. */
  readonly onDone?: () => void;
  /**
   * Plain words for a refusal this screen knows (a 409 detail such as `not_draft`), or `null` to
   * use the shared error sentence.
   */
  readonly explainFailure?: (failure: unknown) => string | null;
  /**
   * A way forward offered under the refusal (e.g. "Archive it instead"). `run` sends another
   * request through this dialog: busy while it runs, its own refusal shown here, closed (without
   * `onDone`) when it succeeds.
   */
  readonly failureAction?: (
    failure: unknown,
    run: (other: () => Promise<void>) => void,
  ) => ReactNode;
}

/** The API answered 409: the thing is not in a state that allows this (or changed meanwhile). */
export function isConflict(failure: unknown): boolean {
  return failure instanceof ApiRequestError && failure.status === 409;
}

/** The first `details[].message` of a 409, the API's machine word for why it said no. */
export function conflictReason(failure: unknown): string | null {
  if (!isConflict(failure)) return null;
  return (failure as ApiRequestError).details[0]?.message ?? null;
}

/**
 * **One confirm step for every lifecycle action** (fix lane C, 2026-11-23): delete a team, a label,
 * a form, a draft quote or invoice, and rename, archive or delete a project. It is the
 * `DeleteDeliverable` pattern made reusable: a small outline button opens a dialog that says what
 * will happen, the action is sent only on confirm, a refusal stays in the dialog as a sentence
 * (never a raw code) with an optional way forward, and Cancel is always there. The caller decides
 * whether the button is shown at all; the API decides every request.
 */
export function ConfirmActionButton({
  triggerLabel,
  triggerAccessibleLabel,
  title,
  body,
  confirmLabel,
  busyLabel,
  failedTitle,
  tone = 'destructive',
  children,
  confirmDisabled = false,
  onOpen,
  onConfirm,
  onDone,
  explainFailure,
  failureAction,
}: ConfirmActionButtonProps) {
  const tOr = useTOr();
  const describe = useDescribeApiError();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ readonly cause: unknown } | null>(null);

  const close = () => {
    if (busy) return;
    setOpen(false);
    setFailure(null);
  };

  async function send(action: () => Promise<void>, after?: () => void): Promise<void> {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (cause) {
      setBusy(false);
      setFailure({ cause });
      return;
    }
    setBusy(false);
    setOpen(false);
    after?.();
  }

  function confirm(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (confirmDisabled) return;
    void send(onConfirm, onDone);
  }

  return (
    <>
      <button
        type="button"
        className="tm-button tm-button--outline tm-button--compact"
        aria-label={triggerAccessibleLabel}
        onClick={() => {
          onOpen?.();
          setFailure(null);
          setOpen(true);
        }}
      >
        {triggerLabel}
      </button>
      {open ? (
        <WorkDialogFrame labelledBy={titleId} onClose={close}>
          <form className="tm-stack" noValidate onSubmit={confirm}>
            <h2 id={titleId} className="tm-wk-dialog__title">
              {title}
            </h2>
            <p className="tm-wk-dialog__lede">{body}</p>
            {children}
            {failure ? (
              <InlineAlert tone="danger" title={failedTitle} live>
                {explainFailure?.(failure.cause) ?? describe(failure.cause)}
              </InlineAlert>
            ) : null}
            {failure && failureAction
              ? failureAction(failure.cause, (other) => void send(other))
              : null}
            <div className="tm-wk-dialog__actions">
              <Button tone="outline" size="accessible" onClick={close}>
                {tOr('ConfirmAction.cancel', 'Cancel')}
              </Button>
              <Button
                type="submit"
                tone={tone}
                size="accessible"
                loading={busy}
                loadingLabel={busyLabel}
                disabled={confirmDisabled}
              >
                {confirmLabel}
              </Button>
            </div>
          </form>
        </WorkDialogFrame>
      ) : null}
    </>
  );
}
