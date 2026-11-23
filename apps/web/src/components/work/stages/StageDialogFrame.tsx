'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * The modal frame of the stages dialogs (new stage set, delete a stage, delete a set): a native
 * `<dialog>` opened with `showModal()`, so the page behind is inert, focus stays inside and Escape
 * is the browser's own close request (HTML "native first", UX-9; WAI-ARIA APG "Dialog (Modal)").
 *
 * On open, focus goes to the element marked `data-autofocus` (the name box), else stays where the
 * browser puts it; on close it goes back to the control that opened the dialog. `kind` lets the
 * phone layout make New stage set a whole page and a confirmation a bottom sheet (Figma W8, W9).
 */
export function StageDialogFrame({
  labelledBy,
  kind,
  onClose,
  children,
}: {
  labelledBy: string;
  kind: 'page' | 'sheet';
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const latest = useRef(onClose);
  useEffect(() => {
    latest.current = onClose;
  });
  useEffect(() => {
    const opener = document.activeElement;
    const node = dialog.current;
    if (node && !node.open) {
      if (typeof node.showModal === 'function') node.showModal();
      else node.setAttribute('open', '');
    }
    node?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);
  return (
    // eslint-disable-next-line jsx-a11y/no-redundant-roles -- use-dismiss reads the role attribute
    <dialog
      ref={dialog}
      className="tm-stg-dialog"
      data-kind={kind}
      // Named for the Work popovers' dismiss rule (`use-dismiss.ts`), which leaves an Escape or a
      // press inside another modal dialog to that dialog.
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      onCancel={(event) => {
        event.preventDefault();
        latest.current();
      }}
    >
      {children}
    </dialog>
  );
}
