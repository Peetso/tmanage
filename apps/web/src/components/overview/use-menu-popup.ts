'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

/**
 * The keyboard and pointer model of the one-page menus (the Activity tab's Person and date chips,
 * the project tab row's "More", D5): the trigger opens a `role="menu"`; focus goes to the checked
 * item (`aria-checked` / `aria-current`) or the first; arrows move inside; Escape and a pick return
 * focus to the trigger; Tab or a click outside closes it. Same model as the project Export menu.
 */
export function useMenuPopup<Trigger extends HTMLElement = HTMLButtonElement>(itemRole: string) {
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<Trigger>(null);
  const [open, setOpen] = useState(false);
  const selector = `[role="${itemRole}"]`;

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    const items = root.current?.querySelectorAll<HTMLElement>(selector);
    const chosen = root.current?.querySelector<HTMLElement>(
      `${selector}[aria-checked="true"], ${selector}[aria-current="page"]`,
    );
    (chosen ?? items?.[0])?.focus();
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open, selector]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  function onMenuKey(event: KeyboardEvent<HTMLElement>) {
    const items = [...(root.current?.querySelectorAll<HTMLElement>(selector) ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(at + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(at - 1 + items.length) % items.length]?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  }

  return {
    menuId,
    root,
    trigger,
    open,
    toggle: () => setOpen((current) => !current),
    close,
    onMenuKey,
  };
}
