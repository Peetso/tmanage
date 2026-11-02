'use client';

import type { SuggestionOptions } from '@tiptap/suggestion';

import type { ApiClient } from '../../../lib/api/client';
import { listMembers } from '../../../lib/api/members';
import { search } from '../../../lib/api/search';
import { initialsFor } from '../doc-markdown';
import { popupRenderer, type PopupState } from './SlashMenu';

/** One person the "@" list offers; picked, it becomes `span[data-type=mention][data-id][data-label]`. */
export interface MentionItem {
  readonly id: string;
  readonly label: string;
}

/**
 * The "@" suggestion: the organization's people directory (`GET …/members?q=`, answered by the
 * server so the whole roster never comes down for a keystroke), eight at a time.
 */
export function mentionSuggestion(
  api: ApiClient,
  organizationSlug: string,
  onChange: (state: PopupState<MentionItem> | null) => void,
): Partial<SuggestionOptions<MentionItem>> {
  return {
    char: '@',
    items: async ({ query }) => {
      try {
        const { members } = await listMembers(api, organizationSlug, { q: query, limit: 8 });
        return members.map((member) => ({ id: member.userId, label: member.displayName }));
      } catch {
        return [];
      }
    },
    render: popupRenderer(onChange),
  };
}

/** The in-app address of one work item — the same `/{org}/work/{id}` global search links to. */
export function workItemHref(organizationSlug: string, workItemId: string): string {
  return `/${encodeURIComponent(organizationSlug)}/work/${encodeURIComponent(workItemId)}`;
}

/**
 * The "#" suggestion (A20): work items from global search (`GET …/search?q=`, the same reader the
 * search screen uses), eight at a time. Picked, the title is inserted as a link that opens the item.
 */
export function workItemSuggestion(
  api: ApiClient,
  organizationSlug: string,
  onChange: (state: PopupState<MentionItem> | null) => void,
): Partial<SuggestionOptions<MentionItem>> {
  return {
    char: '#',
    items: async ({ query }) => {
      if (query.trim() === '') return [];
      try {
        const hits = await search(api, organizationSlug, { q: query, limit: 20 });
        return hits
          .filter((hit) => hit.kind === 'work_item')
          .slice(0, 8)
          .map((hit) => ({ id: hit.id, label: hit.title }));
      } catch {
        return [];
      }
    },
    command: ({ editor, range, props }) => {
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          {
            type: 'text',
            text: props.label,
            marks: [{ type: 'link', attrs: { href: workItemHref(organizationSlug, props.id) } }],
          },
          { type: 'text', text: ' ' },
        ])
        .run();
    },
    render: popupRenderer(onChange),
  };
}

export interface MentionListProps {
  readonly state: PopupState<MentionItem>;
  readonly ariaLabel: string;
  readonly noneLabel: string;
  /** The row's leading glyph; people get their initials, work items a "#". */
  readonly glyph?: (item: MentionItem) => string;
}

export function MentionList({
  state,
  ariaLabel,
  noneLabel,
  glyph = (item) => initialsFor(item.label),
}: MentionListProps) {
  const rect = state.rect;
  return (
    <div
      className="tm-docpage__slash tm-doced__popup"
      style={rect ? { position: 'fixed', top: rect.bottom + 4, left: rect.left } : undefined}
    >
      {state.items.length > 0 ? (
        <ul role="listbox" aria-label={ariaLabel}>
          {state.items.map((item, index) => (
            <li
              key={item.id}
              role="option"
              aria-selected={index === state.active}
              className="tm-docpage__slash-item"
              onMouseDown={(event) => {
                event.preventDefault();
                state.pick(item);
              }}
            >
              <span className="tm-doced__orb" aria-hidden="true">
                {glyph(item)}
              </span>
              <span className="tm-doced__popup-label" dir="auto">
                {item.label}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="tm-docpage__slash-none">{noneLabel}</p>
      )}
    </div>
  );
}
