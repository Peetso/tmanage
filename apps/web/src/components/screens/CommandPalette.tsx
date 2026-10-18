'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchCommands } from '../../lib/api/commands';
import type { Command } from '../../lib/api/commands';
import type { ApiClient } from '../../lib/api/client';

/**
 * The window event any control may dispatch to open the palette — the search orb in HOME-01's
 * day capsule uses it. An event rather than a context, so the opener needs no provider.
 */
export const OPEN_COMMAND_PALETTE_EVENT = 'tm:open-command-palette';

export interface CommandPaletteProps {
  organizationSlug: string;
  /** Test seam: an explicit client and an initially-open palette. */
  client?: ApiClient;
  initiallyOpen?: boolean;
}

/**
 * **SRCH command palette (x181).**
 *
 * `38-MODULE-MAP` §Search, command & AI: a keyboard-driven command palette over the existing search.
 * Opened with Ctrl/Cmd-K, it lists the commands the API returns for the typed query — a static,
 * allowlisted registry the server matches — plus a "search the workspace for …" entry and the last
 * search this tenant ran. The AI copilot is out of scope (Needs-Peter, external LLM).
 *
 * ## Why the dialog is a separate component
 *
 * This outer component is what {@link AppShell} mounts on every internal screen, so it must be cheap
 * and context-free while closed: it uses only `useState` and one document `keydown` listener, and
 * renders **nothing** until opened. The parts that need React Query and the DOM — the fetch, the
 * focus trap, the keyboard list — live in {@link CommandPaletteDialog}, which is mounted only when the
 * palette is open. A screen test that renders the shell therefore never pays for a `QueryClient` or a
 * router it did not set up, because the dialog that would need them is not in the tree.
 */
export function CommandPalette({ organizationSlug, client, initiallyOpen }: CommandPaletteProps) {
  const [open, setOpen] = useState<boolean>(initiallyOpen ?? false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      }
    }
    function onOpen() {
      setOpen(true);
    }
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
    };
  }, []);

  if (!open) return null;

  return (
    <CommandPaletteDialog
      organizationSlug={organizationSlug}
      {...(client ? { client } : {})}
      onClose={() => setOpen(false)}
    />
  );
}

interface CommandPaletteDialogProps {
  organizationSlug: string;
  client?: ApiClient;
  onClose: () => void;
}

/** The recent-search key is per-organization so one tenant's history never shows in another. */
function recentKey(slug: string): string {
  return `tmanage.recent-search.${slug}`;
}

function readRecentSearch(slug: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(recentKey(slug));
    return value && value.trim() !== '' ? value : null;
  } catch {
    return null;
  }
}

function writeRecentSearch(slug: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(recentKey(slug), value);
  } catch {
    // A private window or blocked storage is not an error the palette should surface.
  }
}

function clearRecentSearch(slug: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(recentKey(slug));
  } catch {
    // Ignore — see writeRecentSearch.
  }
}

/** In-app navigation without a router dependency: a real assign so the shell need wire nothing. */
function navigateTo(path: string): void {
  if (typeof window !== 'undefined') window.location.assign(path);
}

/** The rows the palette can offer, in the order they render. A discriminated union so activation is exhaustive. */
type Entry =
  | { readonly kind: 'search'; readonly id: string; readonly label: string; readonly query: string }
  | { readonly kind: 'recent'; readonly id: string; readonly label: string; readonly query: string }
  | {
      readonly kind: 'command';
      readonly id: string;
      readonly label: string;
      readonly command: Command;
    };

/**
 * The open palette: a focus-trapped dialog listing the commands the API returns for the typed query,
 * plus a search entry and the recent search. It dispatches only what the server returned — a
 * `navigate` command follows its `href`; an `action` command is routed through a hardcoded `switch`
 * over the closed action-id set. The typed query is only a filter and the seed for a search; it is
 * never a command, an href or an action, so the palette can never run anything the registry did not
 * declare (the no-injection property the API matcher proves).
 */
function CommandPaletteDialog({ organizationSlug, client, onClose }: CommandPaletteDialogProps) {
  const api = client ?? browserApiClient();

  const [draft, setDraft] = useState<string>('');
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [recent, setRecent] = useState<string | null>(() => readRecentSearch(organizationSlug));

  const inputRef = useRef<HTMLInputElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const baseId = useId();
  const query = draft.trim();

  // Move focus to the input on mount and restore it to wherever it was on unmount (the focus trap's
  // bookends). Runs once: the dialog is remounted each time the palette opens.
  useEffect(() => {
    restoreFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
    inputRef.current?.focus();
    return () => restoreFocusRef.current?.focus?.();
  }, []);

  const commandsQuery = useQuery({
    queryKey: ['command-palette', organizationSlug, query],
    queryFn: () => fetchCommands(api, organizationSlug, query === '' ? {} : { q: query }),
  });

  const commands = useMemo<readonly Command[]>(
    () => commandsQuery.data ?? [],
    [commandsQuery.data],
  );

  const entries = useMemo<readonly Entry[]>(() => {
    const rows: Entry[] = [];
    if (query !== '') {
      rows.push({
        kind: 'search',
        id: `${baseId}-search`,
        label: `Search the workspace for “${query}”`,
        query,
      });
    }
    if (recent && recent !== query) {
      rows.push({
        kind: 'recent',
        id: `${baseId}-recent`,
        label: `Recent search: ${recent}`,
        query: recent,
      });
    }
    for (const command of commands) {
      rows.push({
        kind: 'command',
        id: `${baseId}-cmd-${command.id}`,
        label: command.title,
        command,
      });
    }
    return rows;
  }, [baseId, commands, query, recent]);

  useEffect(() => {
    setActiveIndex((index) => (entries.length === 0 ? 0 : Math.min(index, entries.length - 1)));
  }, [entries.length]);

  const goToSearch = useCallback(
    (searchQuery: string) => {
      if (searchQuery.trim() === '') return;
      writeRecentSearch(organizationSlug, searchQuery);
      navigateTo(
        `/${encodeURIComponent(organizationSlug)}/search?q=${encodeURIComponent(searchQuery)}`,
      );
      onClose();
    },
    [onClose, organizationSlug],
  );

  const activate = useCallback(
    (entry: Entry | undefined) => {
      if (!entry) return;
      if (entry.kind === 'search' || entry.kind === 'recent') {
        goToSearch(entry.query);
        return;
      }
      const command = entry.command;
      if (command.kind === 'navigate' && command.href) {
        navigateTo(`/${encodeURIComponent(organizationSlug)}${command.href}`);
        onClose();
        return;
      }
      // An action is dispatched through a closed switch — never from the query text.
      switch (command.action) {
        case 'open-search':
          goToSearch(query);
          break;
        case 'clear-recent-search':
          clearRecentSearch(organizationSlug);
          setRecent(null);
          break;
        default:
          // An unknown action id (impossible from the allowlisted registry) is ignored, never run.
          break;
      }
    },
    [goToSearch, onClose, organizationSlug, query],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((index) => (entries.length === 0 ? 0 : (index + 1) % entries.length));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((index) =>
          entries.length === 0 ? 0 : (index - 1 + entries.length) % entries.length,
        );
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        activate(entries[activeIndex]);
        return;
      }
      if (event.key === 'Tab') {
        // Focus trap: the input is the only tabbable control, so keep focus on it.
        event.preventDefault();
        inputRef.current?.focus();
      }
    },
    [activate, activeIndex, entries, onClose],
  );

  const activeEntry = entries[activeIndex];
  const listId = `${baseId}-list`;
  const titleId = `${baseId}-title`;

  return (
    <div className="tm-command-palette__backdrop">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="tm-command-palette">
        <h2 id={titleId} className="tm-command-palette__title tm-visually-hidden">
          Command palette
        </h2>
        <div className="tm-command-palette__head">
          <span className="tm-command-palette__live" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeEntry ? activeEntry.id : undefined}
            aria-label="Search commands and the workspace"
            className="tm-command-palette__input"
            placeholder="Type a command or search…"
            value={draft}
            onKeyDown={onKeyDown}
            onChange={(event) => {
              setDraft(event.target.value);
              setActiveIndex(0);
            }}
          />
          <kbd className="tm-command-palette__key" aria-hidden="true">
            Esc
          </kbd>
        </div>
        <ul id={listId} role="listbox" aria-label="Commands" className="tm-command-palette__list">
          {entries.length === 0 ? (
            <li
              className="tm-command-palette__empty"
              role="option"
              aria-selected="false"
              aria-disabled="true"
            >
              No commands match.
            </li>
          ) : (
            entries.map((entry, index) => (
              // Activation by keyboard is on the input (the aria-activedescendant owner); this click
              // is the pointer affordance for the same action, so the key-events rule does not apply.
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events
              <li
                key={entry.id}
                id={entry.id}
                role="option"
                aria-selected={index === activeIndex}
                className="tm-command-palette__option"
                onClick={() => activate(entry)}
              >
                <span className="tm-command-palette__option-orb" aria-hidden="true">
                  {entry.kind === 'command' ? '›' : '⌕'}
                </span>
                <span className="tm-command-palette__option-label">{entry.label}</span>
                {entry.kind === 'command' ? (
                  <span className="tm-command-palette__option-section">
                    {entry.command.section}
                  </span>
                ) : null}
              </li>
            ))
          )}
        </ul>
        <p className="tm-command-palette__foot">Results are filtered to what you may see</p>
      </div>
    </div>
  );
}
