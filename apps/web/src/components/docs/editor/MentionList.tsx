'use client';

import type { SuggestionOptions } from '@tiptap/suggestion';

import type { ApiClient } from '../../../lib/api/client';
import { listMembers } from '../../../lib/api/members';
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

export interface MentionListProps {
  readonly state: PopupState<MentionItem>;
  readonly ariaLabel: string;
  readonly noneLabel: string;
}

export function MentionList({ state, ariaLabel, noneLabel }: MentionListProps) {
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
                {initialsFor(item.label)}
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
