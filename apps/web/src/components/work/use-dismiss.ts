'use client';

import { useEffect, useRef, type RefObject } from 'react';

/**
 * Closes an open popover or menu of the Work area the way every popover here behaves (WAI-ARIA
 * APG "Disclosure" and "Menu Button": Escape closes and returns focus to the trigger; a press
 * outside closes without a change). Listens on the document only while open, so a closed control
 * costs nothing and the wrapping element stays a plain, non-interactive box.
 *
 * A press inside a modal dialog (a picker opened from the popover, portalled elsewhere) does not
 * count as outside.
 */
export function useDismiss(
  open: boolean,
  box: RefObject<HTMLElement | null>,
  onDismiss: (reason: 'escape' | 'outside') => void,
): void {
  const latest = useRef(onDismiss);
  useEffect(() => {
    latest.current = onDismiss;
  });

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (box.current?.contains(target)) return;
      if (target?.closest?.('[role="dialog"][aria-modal="true"]')) return;
      latest.current('outside');
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // An Escape aimed at a modal dialog belongs to that dialog.
      if ((event.target as Element | null)?.closest?.('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      latest.current('escape');
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, box]);
}
