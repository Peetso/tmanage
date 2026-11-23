'use client';

import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ApiClient } from '../../lib/api/client';
import { searchMentionCandidates } from '../../lib/api/mention-candidates';
import type { MentionCandidate } from '../../lib/api/mention-candidates';
import { useTOr } from '../../lib/i18n/use-t-or';
import { initialsOf } from './channel-browser';
import './chat-shell.css';
import { PersonAvatar } from '../people/PersonAvatar';

/**
 * **m-mention** — the @ picker over a channel composer.
 *
 * Typing `@` at the start of a word (or pressing the composer's round "@" button) opens it; the
 * letters after the `@` are the search, answered by `…/mention-candidates?q=` so only people who
 * can read the channel are offered. Two groups: PROJECT MEMBERS (on the channel's project) and
 * OTHERS WHO CAN SEE THIS CHANNEL. ↑↓ moves, Enter (or Tab) mentions, Esc closes.
 *
 * The textarea shows the person's name — "@Lina Samir" — because a raw id is not something anyone
 * can read back. The API's token (`@<userId>`) is what is sent: `encodeMentions` swaps every name
 * picked here for its token at send time, so the mention notification still fires.
 */

export type MentionGroup = 'project' | 'others';

export interface MentionOption {
  readonly userId: string;
  readonly displayName: string;
  readonly mention: string;
  readonly group: MentionGroup;
  readonly subtitle?: string;
}

/** The open `@word` before the caret, or null. The `@` must start a word. */
export function findMentionQuery(
  text: string,
  caret: number,
): { readonly start: number; readonly query: string } | null {
  for (let index = caret - 1; index >= 0; index -= 1) {
    const char = text[index] as string;
    if (char === '@') {
      const before = index === 0 ? ' ' : (text[index - 1] as string);
      if (!/[\s([{"'«]/u.test(before)) return null;
      const query = text.slice(index + 1, caret);
      if (query.length > 40) return null;
      return { start: index, query };
    }
    if (/\s/u.test(char)) return null;
  }
  return null;
}

/** Replace the `@query` that runs from `start` to `caret` with `@Name ` and place the caret after. */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  displayName: string,
): { readonly text: string; readonly caret: number } {
  const inserted = `@${displayName} `;
  return {
    text: `${text.slice(0, start)}${inserted}${text.slice(caret)}`,
    caret: start + inserted.length,
  };
}

/** Swap every picked `@Name` for the API's token. Longest names first, so "Lina S" never eats "Lina Samir". */
export function encodeMentions(text: string, picked: ReadonlyMap<string, string>): string {
  let out = text;
  const names = [...picked.keys()].sort((a, b) => b.length - a.length);
  for (const name of names) {
    const token = picked.get(name) as string;
    out = out.split(`@${name}`).join(token);
  }
  return out;
}

/** Show a stored body's `@<userId>` tokens as `@Name` for the people this screen can name. */
export function decodeMentions(
  text: string,
  nameOf: (userId: string) => string | undefined,
): string {
  return text.replace(/@([0-9a-z][0-9a-z-]{7,35})/giu, (whole, id: string) => {
    const name = nameOf(id);
    return name === undefined ? whole : `@${name}`;
  });
}

/** A member role as the people screens word it. */
export function memberRoleLabel(
  role: string | undefined,
  tOr: (key: string, en: string) => string,
) {
  switch (role) {
    case 'owner':
      return tOr('MentionPicker.roleOwner', 'Owner');
    case 'org_admin':
    case 'admin':
      return tOr('MentionPicker.roleAdmin', 'Admin');
    case 'manager':
      return tOr('MentionPicker.roleManager', 'Manager');
    case 'member':
      return tOr('MentionPicker.roleMember', 'Member');
    case undefined:
      return undefined;
    default:
      return role.startsWith('client')
        ? tOr('MentionPicker.client', 'Client')
        : role.charAt(0).toUpperCase() + role.slice(1).replace(/_/gu, ' ');
  }
}

export interface MentionPickerProps {
  readonly id: string;
  readonly options: readonly MentionOption[];
  readonly activeIndex: number;
  readonly onPick: (option: MentionOption) => void;
  readonly onHover: (index: number) => void;
  /** C5: the heading over the "others" group — a direct message says "In this conversation". */
  readonly othersHeading?: string;
  /**
   * 2026-10-31 live-test fix: the letters typed after the `@`. With no options the picker shows
   * its empty state — "No one to mention yet" for a bare `@`, "No one matches “…”" otherwise —
   * instead of silently not opening (Figma: "Chat · Mention picker — no one to mention, no match").
   */
  readonly query?: string;
}

/** The floating list itself. Focus stays in the composer; the active option is its active descendant. */
export function MentionPicker({
  id,
  options,
  activeIndex,
  onPick,
  onHover,
  othersHeading,
  query = '',
}: MentionPickerProps) {
  const tOr = useTOr();
  const headingProject = useId();
  const headingOthers = useId();
  const project = options.filter((option) => option.group === 'project');
  const others = options.filter((option) => option.group === 'others');

  function renderOption(option: MentionOption) {
    const index = options.indexOf(option);
    const active = index === activeIndex;
    return (
      <li
        key={option.userId}
        id={`${id}-${index}`}
        role="option"
        aria-selected={active}
        className="tm-mention__option"
        onMouseDown={(event) => {
          // Keep focus (and the caret) in the composer.
          event.preventDefault();
          onPick(option);
        }}
        onMouseEnter={() => onHover(index)}
      >
        <PersonAvatar
          userId={option.userId}
          name={option.displayName}
          className="tm-chat-side__orb tm-mention__orb"
          size="compact"
          decorative
          fallback={
            <span className="tm-chat-side__orb tm-mention__orb" aria-hidden="true">
              {initialsOf(option.displayName)}
            </span>
          }
        />
        <span className="tm-mention__text">
          <span className="tm-mention__name">{option.displayName}</span>
          {option.subtitle ? <span className="tm-mention__sub">{option.subtitle}</span> : null}
        </span>
      </li>
    );
  }

  if (options.length === 0) {
    const needle = query.trim();
    return (
      <div className="tm-mention" data-testid="mention-picker">
        <div id={id} role="status" className="tm-mention__empty">
          <p className="tm-mention__empty-title">
            {needle === ''
              ? tOr('MentionPicker.emptyTitle', 'No one to mention yet')
              : tOr('MentionPicker.noMatchTitle', 'No one matches “{query}”').replace(
                  '{query}',
                  needle,
                )}
          </p>
          <p className="tm-mention__empty-body">
            {needle === ''
              ? tOr(
                  'MentionPicker.emptyBody',
                  'You are the only person in this channel. Invite teammates from People to mention them.',
                )
              : tOr('MentionPicker.noMatchBody', 'Check the spelling, or invite them from People.')}
          </p>
        </div>
        <p className="tm-mention__hint">{tOr('MentionPicker.hintClose', 'Esc to close')}</p>
      </div>
    );
  }

  return (
    <div className="tm-mention" data-testid="mention-picker">
      <div
        id={id}
        role="listbox"
        aria-label={tOr('MentionPicker.label', 'People to mention')}
        className="tm-mention__list"
      >
        {project.length > 0 ? (
          <ul role="group" aria-labelledby={headingProject} className="tm-mention__items">
            <li role="presentation" id={headingProject} className="tm-mention__group">
              {tOr('MentionPicker.projectMembers', 'Project members')}
            </li>
            {project.map(renderOption)}
          </ul>
        ) : null}
        {others.length > 0 ? (
          <ul role="group" aria-labelledby={headingOthers} className="tm-mention__items">
            <li role="presentation" id={headingOthers} className="tm-mention__group">
              {othersHeading ??
                tOr('MentionPicker.othersWhoCanSee', 'Others who can see this channel')}
            </li>
            {others.map(renderOption)}
          </ul>
        ) : null}
      </div>
      <p className="tm-mention__hint">
        {tOr('MentionPicker.hint', '↑↓ to move · Enter to mention · Esc to close')}
      </p>
    </div>
  );
}

export interface MentionComposerOptions {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly conversationId: string;
  readonly draft: string;
  readonly setDraft: (next: string) => void;
  readonly controlRef: RefObject<HTMLTextAreaElement | null>;
  /** People on the channel's project; everyone else who can read the channel is "others". */
  readonly projectMemberIds?: ReadonlySet<string>;
  readonly subtitleOf?: (userId: string, group: MentionGroup) => string | undefined;
  /**
   * C5: a fixed set of people to offer instead of asking the channel's mention-candidates route —
   * a direct message has no channel, and the one person in it is already known. Filtered here on
   * the letters typed after the `@`.
   */
  readonly localCandidates?: readonly MentionCandidate[];
}

/** C5: the local candidates whose name contains the letters typed after the `@`. */
export function filterLocalCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
): readonly MentionCandidate[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return candidates;
  return candidates.filter((row) => row.displayName.toLocaleLowerCase().includes(needle));
}

/**
 * The composer's half of the picker: where the open `@word` is, what the API offers for it, the
 * active option, and the keys that drive it. `onKeyDown` answers true when it used the key, so
 * the composer's own Enter-to-send stays out of the way while a choice is open.
 */
export function useMentionComposer(options: MentionComposerOptions) {
  const { api, organizationSlug, conversationId, draft, setDraft, controlRef } = options;
  const listboxId = useId();
  const [trigger, setTrigger] = useState<{ start: number; query: string } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const dismissedAt = useRef<number | null>(null);
  const picked = useRef(new Map<string, string>());

  const { projectMemberIds, subtitleOf, localCandidates } = options;
  const candidates = useQuery({
    queryKey: ['mention-candidates', organizationSlug, conversationId, trigger?.query ?? ''],
    queryFn: () =>
      searchMentionCandidates(api, organizationSlug, conversationId, trigger?.query ?? ''),
    enabled: trigger !== null && localCandidates === undefined,
    staleTime: 30_000,
  });

  const list = useMemo<readonly MentionOption[]>(() => {
    if (trigger === null) return [];
    const rows =
      localCandidates === undefined
        ? (candidates.data ?? [])
        : filterLocalCandidates(localCandidates, trigger.query);
    const withGroup = rows.map((row) => {
      const group: MentionGroup = projectMemberIds?.has(row.userId) ? 'project' : 'others';
      const subtitle = subtitleOf?.(row.userId, group);
      return {
        ...row,
        group,
        ...(subtitle === undefined ? {} : { subtitle }),
      };
    });
    return [
      ...withGroup.filter((row) => row.group === 'project'),
      ...withGroup.filter((row) => row.group === 'others'),
    ];
  }, [candidates.data, trigger, projectMemberIds, subtitleOf, localCandidates]);

  // 2026-10-31 live-test fix: once the answer is in and it is empty, the picker still opens — on
  // its empty state — so a typed `@` never looks like it did nothing.
  const settled = localCandidates !== undefined || (candidates.isSuccess && !candidates.isFetching);
  const open = trigger !== null && (list.length > 0 || settled);

  const sync = useCallback((text: string, caret: number) => {
    const found = findMentionQuery(text, caret);
    if (found !== null && dismissedAt.current === found.start) {
      setTrigger(null);
      return;
    }
    if (found === null) dismissedAt.current = null;
    setTrigger(found);
    setActiveIndex(0);
  }, []);

  const close = useCallback(() => {
    if (trigger !== null) dismissedAt.current = trigger.start;
    setTrigger(null);
  }, [trigger]);

  const pick = useCallback(
    (option: MentionOption) => {
      const control = controlRef.current;
      const caret = control?.selectionStart ?? draft.length;
      const start = trigger?.start ?? caret;
      const next = insertMention(draft, start, caret, option.displayName);
      picked.current.set(option.displayName, option.mention);
      setDraft(next.text);
      setTrigger(null);
      requestAnimationFrame(() => {
        control?.focus();
        control?.setSelectionRange(next.caret, next.caret);
      });
    },
    [controlRef, draft, setDraft, trigger],
  );

  /** The round "@" button: put an `@` at the caret and open the picker on it. */
  const openAtCaret = useCallback(() => {
    const control = controlRef.current;
    const caret = control?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret);
    const spacer = before === '' || /\s$/u.test(before) ? '' : ' ';
    const text = `${before}${spacer}@${draft.slice(caret)}`;
    const nextCaret = caret + spacer.length + 1;
    setDraft(text);
    dismissedAt.current = null;
    setTrigger({ start: nextCaret - 1, query: '' });
    setActiveIndex(0);
    requestAnimationFrame(() => {
      control?.focus();
      control?.setSelectionRange(nextCaret, nextCaret);
    });
  }, [controlRef, draft, setDraft]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (trigger === null) return false;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return true;
      }
      if (!open || list.length === 0) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex((current) => (current + step + list.length) % list.length);
        return true;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.nativeEvent.isComposing) {
        event.preventDefault();
        const option = list[Math.min(activeIndex, list.length - 1)];
        if (option) pick(option);
        return true;
      }
      return false;
    },
    [trigger, open, list, activeIndex, close, pick],
  );

  const encode = useCallback((text: string) => encodeMentions(text, picked.current), []);

  return {
    open,
    options: list,
    activeIndex,
    setActiveIndex,
    listboxId,
    sync,
    pick,
    close,
    openAtCaret,
    onKeyDown,
    encode,
    /** The letters typed after the `@` — the empty state words its "no match" with them. */
    query: trigger?.query ?? '',
    /** Props for the textarea: the list it drives and the option it points at. */
    controlProps: open
      ? {
          'aria-controls': listboxId,
          ...(list.length > 0
            ? { 'aria-activedescendant': `${listboxId}-${Math.min(activeIndex, list.length - 1)}` }
            : {}),
        }
      : {},
  };
}

/** The round "@" button the m-mention composer draws beside send. */
export function MentionButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      className="tm-chat-side__round"
      aria-label={label}
      title={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <span aria-hidden="true">@</span>
    </button>
  );
}
