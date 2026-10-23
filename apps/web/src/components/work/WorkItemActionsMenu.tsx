'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useA6T } from './DueDatePicker';

export type WorkItemAction = 'edit' | 'owner' | 'dates' | 'duplicate' | 'move' | 'delete';

const ACTIONS: readonly { readonly action: WorkItemAction; readonly key: string }[] = [
  { action: 'edit', key: 'WorkActions.edit' },
  { action: 'owner', key: 'WorkActions.owner' },
  { action: 'dates', key: 'WorkActions.dates' },
  { action: 'duplicate', key: 'WorkActions.duplicate' },
  { action: 'move', key: 'WorkActions.move' },
];

export interface WorkItemActionsMenuProps {
  /** Names the item in the trigger's accessible label ("More actions for …"). */
  readonly itemTitle: string;
  readonly onAction: (action: WorkItemAction) => void;
  readonly disabled?: boolean;
}

/**
 * **Work item actions (A6, Figma fq7-actions-menu).**
 *
 * Edit details, Change owner, Change dates, Duplicate, Move to another project, then — below a
 * rule, in red — Delete work item. A menu button: arrow keys move between items, Escape and a
 * click outside close it, and choosing an item closes it and hands the action back.
 */
export function WorkItemActionsMenu({ itemTitle, onAction, disabled }: WorkItemActionsMenuProps) {
  const t = useA6T();
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  function choose(action: WorkItemAction) {
    setOpen(false);
    onAction(action);
  }

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    const items = [
      ...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
    ];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(at + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(at - 1 + items.length) % items.length]?.focus();
    }
  }

  return (
    <div ref={root} className="tm-wk-menu-anchor">
      <button
        ref={trigger}
        type="button"
        className="tm-wk-more"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t('WorkActions.trigger', { title: itemTitle })}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open ? (
        <div id={menuId} role="menu" tabIndex={-1} className="tm-wk-menu" onKeyDown={onMenuKey}>
          {ACTIONS.map((entry) => (
            <button
              key={entry.action}
              type="button"
              role="menuitem"
              className="tm-wk-menu__item"
              onClick={() => choose(entry.action)}
            >
              {t(entry.key)}
            </button>
          ))}
          <div role="separator" className="tm-wk-menu__rule" />
          <button
            type="button"
            role="menuitem"
            className="tm-wk-menu__item"
            data-tone="danger"
            onClick={() => choose('delete')}
          >
            {t('WorkActions.delete')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
