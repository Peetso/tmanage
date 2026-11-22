'use client';

import { useContext, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import {
  CREATE_ACTIONS,
  TIME_ACTIONS,
  filterByPermission,
  moveActive,
  type PaletteItemSpec,
} from './command-palette-model';
import { runPaletteAction } from './palette-actions';
import { useShellCapability } from './use-shell-capability';
import './command-palette-v2.css';

export interface NewMenuProps {
  organizationSlug: string;
  /** Test seams: an explicit client and where a link goes. */
  client?: ApiClient;
  navigate?: (path: string) => void;
  /** `outline`: the quiet "+ New" of the dashboard title row (Figma 795:931); `ink` elsewhere. */
  variant?: 'ink' | 'outline';
}

function assign(path: string): void {
  if (typeof window !== 'undefined') window.location.assign(path);
}

/**
 * **Row 55-05 — the global "+ New" button** (Figma 589:33479, "+ New menu"). Sits in every
 * internal screen's header and opens a menu of the create actions — task, project, doc, meeting —
 * then log time and start timer. The same rows the palette's CREATE group offers
 * ({@link CREATE_ACTIONS}), filtered by the person's role so it never offers a refusal; a role
 * that may create nothing sees no button at all.
 *
 * A WAI-ARIA menu button: Enter / Space / ArrowDown open it on the first item, ArrowUp on the last;
 * arrows, Home and End move; Escape closes and returns focus to the button; Tab closes.
 */
export function NewMenu({
  organizationSlug,
  client,
  navigate = assign,
  variant = 'ink',
}: NewMenuProps) {
  const tOr = useTOr();
  const locale = useActiveLocale();
  const queryClient = useContext(QueryClientContext);
  const may = useShellCapability(organizationSlug, client);
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const [failed, setFailed] = useState<false | 'failed' | 'no-project'>(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();

  const create = filterByPermission(CREATE_ACTIONS, may);
  const time = filterByPermission(TIME_ACTIONS, may);
  const items = [...create, ...time];

  useEffect(() => {
    if (open) itemRefs.current[focusIndex]?.focus();
  }, [open, focusIndex]);

  // A pointer press outside the button and the menu closes it, as every menu in the shell does.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  if (items.length === 0) return null;

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  };

  const openAt = (index: number) => {
    setFailed(false);
    setFocusIndex(index);
    setOpen(true);
  };

  const activate = async (item: PaletteItemSpec) => {
    const base = `/${encodeURIComponent(organizationSlug)}`;
    if (item.run.type === 'href') {
      close(false);
      navigate(`${base}${item.run.href}`);
      return;
    }
    if (item.run.type !== 'action') return;
    const outcome = await runPaletteAction(item.run.action, {
      api: client ?? browserApiClient(),
      organizationSlug,
      queryClient: queryClient ?? undefined,
      navigate,
      locale,
      untitledDoc: tOr('DocsSidebar.untitled', 'Untitled doc'),
      firstProjectName: tOr('DocsSidebar.firstProjectName', 'General'),
    });
    if (outcome === 'done') close(true);
    else setFailed(outcome);
  };

  const onButtonKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openAt(0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openAt(items.length - 1);
    }
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      event.key === 'ArrowDown' ||
      event.key === 'ArrowUp' ||
      event.key === 'Home' ||
      event.key === 'End'
    ) {
      event.preventDefault();
      setFocusIndex((index) => moveActive(index, items.length, event.key as 'Home'));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') {
      close(false);
    }
  };

  const renderItem = (item: PaletteItemSpec, index: number) => (
    <button
      key={item.id}
      ref={(node) => {
        itemRefs.current[index] = node;
      }}
      type="button"
      role="menuitem"
      tabIndex={index === focusIndex ? 0 : -1}
      className="tm-new-menu__item"
      onClick={() => void activate(item)}
    >
      {tOr(item.messageKey, item.fallback)}
    </button>
  );

  return (
    <div className="tm-new-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`tm-button tm-new-menu__button ${
          variant === 'outline' ? 'tm-button--outline tm-button--compact' : 'tm-button--ink'
        }`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : openAt(0))}
        onKeyDown={onButtonKeyDown}
      >
        <span aria-hidden="true" className="tm-new-menu__plus">
          +
        </span>
        {tOr('CommandPaletteV2.new', 'New')}
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          tabIndex={-1}
          aria-label={tOr('CommandPaletteV2.newMenuAria', 'Create something new')}
          className="tm-new-menu__panel"
          onKeyDown={onMenuKeyDown}
        >
          {create.map((item, index) => renderItem(item, index))}
          {create.length > 0 && time.length > 0 ? (
            <div role="separator" className="tm-new-menu__rule" />
          ) : null}
          {time.map((item, index) => renderItem(item, create.length + index))}
          {failed ? (
            <p role="alert" className="tm-new-menu__error">
              {failed === 'no-project'
                ? tOr(
                    'CommandPaletteV2.noProjectForDoc',
                    'Docs live in a project, and you cannot create one here. Ask an owner to add you to a project.',
                  )
                : tOr('CommandPaletteV2.actionFailed', 'That did not work. Try again.')}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
