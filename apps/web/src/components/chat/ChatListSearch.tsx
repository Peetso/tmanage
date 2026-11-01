'use client';

import { useTOr } from '../../lib/i18n/use-t-or';

export interface ChatListSearchProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
}

/** The chat list's search box: narrows by title and last message, client-side. */
export function ChatListSearch({ value, onChange }: ChatListSearchProps) {
  const tOr = useTOr();
  const label = tOr('ChatList.searchLabel', 'Search chats');
  return (
    <label className="tm-chatlist__search">
      <span className="tm-chatlist__search-glyph" aria-hidden="true">
        ⌕
      </span>
      <span className="tm-visually-hidden">{label}</span>
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={tOr('ChatList.searchPlaceholder', 'Search or start a new chat')}
        maxLength={120}
      />
    </label>
  );
}
