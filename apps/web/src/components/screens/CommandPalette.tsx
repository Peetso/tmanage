'use client';

import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { QueryClientContext, useQuery } from '@tanstack/react-query';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchCommands } from '../../lib/api/commands';
import type { Command } from '../../lib/api/commands';
import type { ApiClient } from '../../lib/api/client';
import { search } from '../../lib/api/search';
import { localeDirection } from '../../lib/i18n/direction';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import {
  PALETTE_SPECS,
  filterByPermission,
  flattenSections,
  moveActive,
  parseRecentItems,
  pushRecentItem,
  rankPalette,
  recentItemsKey,
  resultHref,
  type PaletteGroupId,
  type PaletteItem,
  type RecentItem,
} from '../shell/command-palette-model';
import { runPaletteAction } from '../shell/palette-actions';
import { useShellCapability } from '../shell/use-shell-capability';
import '../shell/command-palette-v2.css';

/**
 * The window event any control may dispatch to open the palette — the search orb in HOME-01's
 * day capsule and the `/` shortcut use it. An event rather than a context, so the opener needs no
 * provider.
 */
export const OPEN_COMMAND_PALETTE_EVENT = 'tm:open-command-palette';

export interface CommandPaletteProps {
  organizationSlug: string;
  /** Test seams: an explicit client, an initially-open palette, where a link goes, the debounce. */
  client?: ApiClient;
  initiallyOpen?: boolean;
  navigate?: (path: string) => void;
  searchDelayMs?: number;
}

/** In-app navigation without a router dependency: a real assign so the shell need wire nothing. */
function assign(path: string): void {
  if (typeof window !== 'undefined') window.location.assign(path);
}

/** Ctrl/Cmd-K, read by physical key too, so it works on an Arabic or Urdu keyboard layout. */
function isPaletteChord(event: KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
  return event.key.toLowerCase() === 'k' || event.code === 'KeyK';
}

/**
 * **Command palette v2 (rows SRCH x181 → 55-06).** Figma "R48 L2" (589:33479).
 *
 * Ctrl/Cmd-K (or `/` through the shortcut layer, or the day capsule's search orb) opens a
 * keyboard-only palette with grouped sections: SEARCH the workspace for the typed text, RECENT
 * (what was opened from here, and the last search), CREATE (task, project, doc, meeting), ACTIONS
 * (log time, start timer, switch workspace, language, theme), GO TO (the rail, plus the server's
 * command registry) and the live hits of the existing search API. Every gated row is filtered by
 * the person's role; ranking and filtering live in `command-palette-model.ts`.
 *
 * ## Why the dialog is a separate component
 *
 * This outer component is what {@link AppShell} mounts on every internal screen, so it must be cheap
 * and context-free while closed: it uses only `useState` and one document `keydown` listener, and
 * renders **nothing** until opened. The parts that need React Query and the DOM live in
 * {@link CommandPaletteDialog}, mounted only while the palette is open.
 */
export function CommandPalette({
  organizationSlug,
  client,
  initiallyOpen,
  navigate,
  searchDelayMs,
}: CommandPaletteProps) {
  const [open, setOpen] = useState<boolean>(initiallyOpen ?? false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isPaletteChord(event)) {
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
      navigate={navigate ?? assign}
      searchDelayMs={searchDelayMs ?? 200}
      onClose={() => setOpen(false)}
    />
  );
}

interface CommandPaletteDialogProps {
  organizationSlug: string;
  client?: ApiClient;
  navigate: (path: string) => void;
  searchDelayMs: number;
  onClose: () => void;
}

/** The recent-search key is per-organization so one tenant's history never shows in another. */
function recentKey(slug: string): string {
  return `tmanage.recent-search.${slug}`;
}

function readStorage(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // A private window or blocked storage is not an error the palette should surface.
  }
}

const GROUP_LABELS: Readonly<Record<PaletteGroupId, readonly [string, string]>> = {
  search: ['CommandPaletteV2.groupSearch', 'Search'],
  recent: ['CommandPaletteV2.groupRecent', 'Recent'],
  create: ['CommandPaletteV2.groupCreate', 'Create'],
  actions: ['CommandPaletteV2.groupActions', 'Actions'],
  navigate: ['CommandPaletteV2.groupNavigate', 'Go to'],
  results: ['CommandPaletteV2.groupResults', 'In the workspace'],
};

const KIND_LABELS: Readonly<Record<string, string>> = {
  work_item: 'Work item',
  project: 'Project',
  document: 'Doc',
  meeting: 'Meeting',
  message: 'Message',
  decision: 'Decision',
  invoice: 'Invoice',
  quote: 'Quote',
  expense: 'Expense',
  file: 'File',
};

const GROUP_ORB: Readonly<Record<PaletteGroupId, string>> = {
  search: '⌕',
  recent: '↺',
  create: '+',
  actions: '›',
  navigate: '→',
  results: '◆',
};

/** The typed text, settled: live reads wait until typing pauses. */
function useSettled(value: string, delayMs: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (delayMs <= 0) {
      setSettled(value);
      return;
    }
    const id = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return settled;
}

/**
 * The open palette: a focus-trapped dialog. It dispatches only what a row declares — an
 * org-relative `href`, a closed local action, or a server registry action through a closed
 * `switch`. The typed query is only a filter and the seed for a search; it is never an href or
 * an action, so the palette can never run anything the registry or this file did not declare.
 */
function CommandPaletteDialog({
  organizationSlug,
  client,
  navigate,
  searchDelayMs,
  onClose,
}: CommandPaletteDialogProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const tOr = useTOr();
  const locale = useActiveLocale();
  const queryClient = useContext(QueryClientContext);
  const may = useShellCapability(organizationSlug, client);

  const [draft, setDraft] = useState<string>('');
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [failed, setFailed] = useState<false | 'failed' | 'no-project'>(false);
  const [recentSearch, setRecentSearch] = useState<string | null>(() => {
    const value = readStorage(recentKey(organizationSlug));
    return value && value.trim() !== '' ? value : null;
  });
  const [recentItems, setRecentItems] = useState<RecentItem[]>(() =>
    parseRecentItems(readStorage(recentItemsKey(organizationSlug))),
  );

  const inputRef = useRef<HTMLInputElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const baseId = useId();
  const query = draft.trim();
  const settled = useSettled(query, searchDelayMs);
  const base = `/${encodeURIComponent(organizationSlug)}`;

  // The focus trap's bookends: focus the input on open, restore the opener's focus on close.
  useEffect(() => {
    restoreFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
    inputRef.current?.focus();
    return () => restoreFocusRef.current?.focus?.();
  }, []);

  const commandsQuery = useQuery({
    queryKey: ['command-palette', organizationSlug, settled],
    queryFn: () => fetchCommands(api, organizationSlug, settled === '' ? {} : { q: settled }),
  });
  const searchQuery = useQuery({
    queryKey: ['command-palette-search', organizationSlug, settled],
    queryFn: () => search(api, organizationSlug, { q: settled, limit: 5 }),
    enabled: settled.length >= 2,
  });

  const commands = useMemo<readonly Command[]>(
    () => commandsQuery.data ?? [],
    [commandsQuery.data],
  );

  const rtl = localeDirection(locale) === 'rtl';
  const darkNow =
    typeof document !== 'undefined' && document.documentElement.dataset['theme'] === 'dark';

  const items = useMemo<PaletteItem[]>(() => {
    const rows: PaletteItem[] = [];
    if (query !== '') {
      rows.push({
        id: 'search-workspace',
        group: 'search',
        label: `${t('CommandPalette.searchWorkspacePrefix')}${query}${t('CommandPalette.searchWorkspaceSuffix')}`,
        preMatched: true,
        run: { type: 'action', action: 'search-workspace' },
      });
    }
    if (recentSearch && recentSearch !== query) {
      rows.push({
        id: 'recent-search',
        group: 'recent',
        label: `${t('CommandPalette.recentSearchPrefix')}${recentSearch}`,
        keywords: [recentSearch],
        run: { type: 'href', href: `/search?q=${encodeURIComponent(recentSearch)}` },
      });
    }
    for (const recent of recentItems) {
      rows.push({
        id: `recent-${recent.id}`,
        group: 'recent',
        label: recent.label,
        run: { type: 'href', href: recent.href },
      });
    }
    // The server's registry first (it matched the query itself): navigation not already on the
    // rail, and its closed action ids.
    const knownHrefs = new Set(
      PALETTE_SPECS.flatMap((spec) => (spec.run.type === 'href' ? [spec.run.href] : [])),
    );
    for (const command of commands) {
      if (command.kind === 'navigate' && command.href && !knownHrefs.has(command.href)) {
        rows.push({
          id: `cmd-${command.id}`,
          group: 'navigate',
          label: command.title,
          preMatched: true,
          run: { type: 'href', href: command.href },
        });
      } else if (command.kind === 'action' && command.action === 'clear-recent-search') {
        if (recentSearch || recentItems.length > 0) {
          rows.push({
            id: `cmd-${command.id}`,
            group: 'actions',
            label: command.title,
            preMatched: true,
            run: { type: 'command', action: command.action },
          });
        }
      }
    }
    for (const spec of filterByPermission(PALETTE_SPECS, may)) {
      let label = tOr(spec.messageKey, spec.fallback);
      if (spec.id === 'toggle-language' && rtl) {
        label = tOr('CommandPaletteV2.switchToEnglish', 'Switch to English');
      }
      if (spec.id === 'toggle-theme' && darkNow) {
        label = tOr('CommandPaletteV2.lightTheme', 'Light theme');
      }
      rows.push({
        id: spec.id,
        group: spec.group,
        label,
        keywords: [spec.fallback, ...(spec.keywords ?? [])],
        ...(spec.capability ? { capability: spec.capability } : {}),
        ...(spec.hint ? { hint: spec.hint } : {}),
        run: spec.run,
      });
    }
    if (settled.length >= 2 && settled === query) {
      for (const hit of searchQuery.data ?? []) {
        const href = resultHref(hit);
        if (href === null) continue;
        rows.push({
          id: `hit-${hit.kind}-${hit.id}`,
          group: 'results',
          label: hit.title,
          tag: tOr(`CommandPaletteV2.kind.${hit.kind}`, KIND_LABELS[hit.kind] ?? hit.kind),
          preMatched: true,
          run: { type: 'href', href },
        });
      }
    }
    return rows;
  }, [
    commands,
    darkNow,
    may,
    query,
    recentItems,
    recentSearch,
    rtl,
    searchQuery.data,
    settled,
    t,
    tOr,
  ]);

  const sections = useMemo(() => rankPalette(items, query), [items, query]);
  const flat = useMemo(() => flattenSections(sections), [sections]);

  useEffect(() => {
    setActiveIndex((index) => (flat.length === 0 ? 0 : Math.min(index, flat.length - 1)));
  }, [flat.length]);

  const go = useCallback(
    (path: string) => {
      navigate(`${base}${path}`);
      onClose();
    },
    [base, navigate, onClose],
  );

  const goToSearch = useCallback(
    (searchText: string) => {
      if (searchText.trim() === '') return;
      writeStorage(recentKey(organizationSlug), searchText);
      go(`/search?q=${encodeURIComponent(searchText)}`);
    },
    [go, organizationSlug],
  );

  const remember = useCallback(
    (item: PaletteItem, href: string) => {
      if (item.group === 'recent' || item.group === 'search') return;
      const next = pushRecentItem(recentItems, { id: item.id, label: item.label, href });
      writeStorage(recentItemsKey(organizationSlug), JSON.stringify(next));
      setRecentItems(next);
    },
    [organizationSlug, recentItems],
  );

  const activate = useCallback(
    async (item: PaletteItem | undefined) => {
      if (!item) return;
      const run = item.run;
      if (run.type === 'href') {
        // `/organizations` (switch workspace) is outside the tenant; every other href is inside it.
        if (run.href === '/organizations') {
          navigate(run.href);
          onClose();
          return;
        }
        remember(item, run.href);
        go(run.href);
        return;
      }
      if (run.type === 'command') {
        // A server action is dispatched through a closed switch — never from the query text.
        switch (run.action) {
          case 'clear-recent-search':
            writeStorage(recentKey(organizationSlug), null);
            writeStorage(recentItemsKey(organizationSlug), null);
            setRecentSearch(null);
            setRecentItems([]);
            break;
          default:
            break;
        }
        return;
      }
      if (run.action === 'search-workspace') {
        goToSearch(query);
        return;
      }
      setFailed(false);
      const outcome = await runPaletteAction(run.action, {
        api,
        organizationSlug,
        queryClient: queryClient ?? undefined,
        navigate,
        locale,
        untitledDoc: tOr('DocsSidebar.untitled', 'Untitled doc'),
        firstProjectName: tOr('DocsSidebar.firstProjectName', 'General'),
      });
      if (outcome === 'done') onClose();
      else setFailed(outcome);
    },
    [
      api,
      go,
      goToSearch,
      locale,
      navigate,
      onClose,
      organizationSlug,
      query,
      queryClient,
      remember,
      tOr,
    ],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((index) => moveActive(index, flat.length, event.key as 'ArrowDown'));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        void activate(flat[activeIndex]);
        return;
      }
      if (event.key === 'Tab') {
        // Focus trap: the input is the only tabbable control, so keep focus on it.
        event.preventDefault();
        inputRef.current?.focus();
      }
    },
    [activate, activeIndex, flat, onClose],
  );

  const optionId = (item: PaletteItem) => `${baseId}-opt-${item.id}`;
  const activeItem = flat[activeIndex];
  const listId = `${baseId}-list`;
  const titleId = `${baseId}-title`;

  return (
    <div className="tm-command-palette__backdrop">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="tm-command-palette">
        <h2 id={titleId} className="tm-command-palette__title tm-visually-hidden">
          {t('CommandPalette.title')}
        </h2>
        <div className="tm-command-palette__head">
          <span className="tm-command-palette__live" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeItem ? optionId(activeItem) : undefined}
            aria-label={t('CommandPalette.searchAria')}
            className="tm-command-palette__input"
            placeholder={t('CommandPalette.placeholder')}
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
        <div
          id={listId}
          role="listbox"
          aria-label={t('CommandPalette.commandsAria')}
          className="tm-command-palette__list"
        >
          {flat.length === 0 ? (
            <div
              className="tm-command-palette__empty"
              role="option"
              aria-selected="false"
              aria-disabled="true"
            >
              {t('CommandPalette.noCommands')}
            </div>
          ) : (
            sections.map((section) => {
              const [labelKey, labelFallback] = GROUP_LABELS[section.group];
              const groupLabelId = `${baseId}-group-${section.group}`;
              return (
                <div
                  key={section.group}
                  role="group"
                  aria-labelledby={groupLabelId}
                  className="tm-command-palette__group"
                  data-group={section.group}
                >
                  <div id={groupLabelId} className="tm-command-palette__group-label">
                    {tOr(labelKey, labelFallback)}
                  </div>
                  {section.items.map((item) => {
                    const selected = item === activeItem;
                    return (
                      // Activation by keyboard is on the input (the aria-activedescendant owner);
                      // this click is the pointer affordance for the same action.
                      // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                      <div
                        key={item.id}
                        id={optionId(item)}
                        role="option"
                        tabIndex={-1}
                        aria-selected={selected}
                        className="tm-command-palette__option"
                        onClick={() => void activate(item)}
                      >
                        <span className="tm-command-palette__option-orb" aria-hidden="true">
                          {GROUP_ORB[item.group]}
                        </span>
                        <span className="tm-command-palette__option-label">{item.label}</span>
                        {item.tag ? (
                          <span className="tm-command-palette__option-section">{item.tag}</span>
                        ) : item.hint ? (
                          <kbd className="tm-command-palette__option-hint" dir="ltr">
                            {item.hint}
                          </kbd>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
        {failed ? (
          <p role="alert" className="tm-command-palette__error">
            {failed === 'no-project'
              ? tOr(
                  'CommandPaletteV2.noProjectForDoc',
                  'Docs live in a project, and you cannot create one here. Ask an owner to add you to a project.',
                )
              : tOr('CommandPaletteV2.actionFailed', 'That did not work. Try again.')}
          </p>
        ) : null}
        <p className="tm-command-palette__foot">
          {tOr('CommandPaletteV2.footKeys', '↑↓ move · Enter open · Esc close')}
        </p>
      </div>
    </div>
  );
}
