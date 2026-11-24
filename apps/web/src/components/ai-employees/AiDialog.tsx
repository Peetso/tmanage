'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button, IconButton } from '@tmanage/ui';
import { useTOr } from '../../lib/i18n/use-t-or';
import { CloseIcon } from '../work/work-icons';

/**
 * The AI-employee screens' modal frame (S2, S3, S4, S6d–f, S8b): the native `<dialog>` opened with
 * `showModal()`, the approved Teams dialog (560 wide, inset 24; a bottom sheet on a phone, Figma
 * `936:99146`, `934:98426`). The platform gives the APG modal behaviour: the page behind is inert,
 * Escape asks to close, focus stays inside and goes back to the opener on close.
 */
export function AiDialogFrame({
  labelledBy,
  onClose,
  wide = false,
  children,
}: {
  readonly labelledBy: string;
  readonly onClose: () => void;
  /** The add chooser's two cards side by side. */
  readonly wide?: boolean;
  readonly children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = dialog.current;
    if (node && !node.open) {
      if (typeof node.showModal === 'function') node.showModal();
      else node.setAttribute('open', '');
    }
    node?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => previous?.focus?.();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="tm-team-dialog tm-aie-dialog"
      data-wide={wide || undefined}
      aria-labelledby={labelledBy}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}

export function AiDialogHead({
  id,
  title,
  onClose,
}: {
  readonly id: string;
  readonly title: string;
  readonly onClose: () => void;
}) {
  const tOr = useTOr();
  return (
    <div className="tm-team-dialog__head">
      <h2 id={id} className="tm-team-dialog__title">
        {title}
      </h2>
      <IconButton
        label={tOr('AiEmployees.close', 'Close')}
        icon={<CloseIcon />}
        className="tm-team-dialog__close"
        onClick={onClose}
      />
    </div>
  );
}

export interface ConfirmDialogProps {
  readonly title: string;
  /** One paragraph per line, as the confirms draw them. */
  readonly lines: readonly string[];
  readonly confirmLabel: string;
  /** Cancel by default; S3d's "Keep setting up". */
  readonly cancelLabel?: string;
  /** `danger`: the confirm is the destructive button (revoke, retire, switch off). */
  readonly tone?: 'danger' | 'primary';
  /** S3d: the safe choice is the lime one and the leaving choice is the quiet one. */
  readonly safeIsPrimary?: boolean;
  readonly onConfirm: () => Promise<void> | void;
  readonly onClose: () => void;
}

/**
 * One confirm for every irreversible or leaving step (S3d close, S6d revoke, S6e retire, S8b switch
 * off). Cancel takes the focus first (APG: the least destructive action); a failed write is said
 * in place and the dialog stays open.
 */
export function ConfirmDialog({
  title,
  lines,
  confirmLabel,
  cancelLabel,
  tone = 'danger',
  safeIsPrimary = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const tOr = useTOr();
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const confirm = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await onConfirm();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };
  const cancel = cancelLabel ?? tOr('AiEmployees.cancel', 'Cancel');
  return (
    <AiDialogFrame labelledBy={titleId} onClose={onClose}>
      <div className="tm-team-dialog__form">
        <AiDialogHead id={titleId} title={title} onClose={onClose} />
        {lines.map((line) => (
          <p key={line} className="tm-team-dialog__body">
            {line}
          </p>
        ))}
        {failed ? (
          <p className="tm-team-dialog__problem" role="alert">
            {tOr('AiEmployees.writeFailed', 'That did not work. Try again.')}
          </p>
        ) : null}
        <div className="tm-team-dialog__actions">
          {safeIsPrimary ? (
            <>
              <Button
                type="button"
                tone="text"
                size="large"
                loading={busy}
                onClick={() => void confirm()}
              >
                {confirmLabel}
              </Button>
              <Button type="button" tone="lime" size="large" data-autofocus onClick={onClose}>
                {cancel}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" tone="text" size="large" data-autofocus onClick={onClose}>
                {cancel}
              </Button>
              <Button
                type="button"
                tone={tone === 'danger' ? 'destructive' : 'lime'}
                size="large"
                loading={busy}
                onClick={() => void confirm()}
              >
                {confirmLabel}
              </Button>
            </>
          )}
        </div>
      </div>
    </AiDialogFrame>
  );
}
