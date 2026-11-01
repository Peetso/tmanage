'use client';

import { useEffect, useRef, useState } from 'react';
import { REACTION_SET } from '../../../lib/api/message-reactions';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useTOr } from '../../../lib/i18n/use-t-or';
import './pane.css';

export interface EmojiPickerProps {
  /**
   * `reaction` offers the curated set the API admits (a grid, no network); `insert` opens the
   * full emoji-mart picker for the composer.
   */
  mode: 'reaction' | 'insert';
  onPick: (emoji: string) => void;
  onClose: () => void;
}

/**
 * R7 slice 4 — the emoji picker. Reactions come from the closed `REACTION_SET`, so a pick is
 * always one the API stores. The composer gets emoji-mart (MIT, loaded on open only), themed by
 * the system colour scheme; in Arabic its search is turned off rather than shown half-working.
 */
export function EmojiPicker({ mode, onPick, onClose }: EmojiPickerProps) {
  const tOr = useTOr();
  const locale = useActiveLocale();
  const hostRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (mode !== 'insert') return;
    let cancelled = false;
    const arabic = locale.toLowerCase().startsWith('ar');
    void (async () => {
      try {
        const [{ Picker }, data, i18n] = await Promise.all([
          import('emoji-mart'),
          import('@emoji-mart/data').then((module) => module.default),
          arabic
            ? import('@emoji-mart/data/i18n/ar.json').then((module) => module.default)
            : Promise.resolve(undefined),
        ]);
        if (cancelled || hostRef.current === null) return;
        const picker = new Picker({
          data,
          ...(i18n === undefined ? {} : { i18n, searchPosition: 'none' }),
          theme: 'auto',
          previewPosition: 'none',
          onEmojiSelect: (emoji: { native?: string }) => {
            if (typeof emoji.native === 'string') pickRef.current(emoji.native);
          },
        });
        hostRef.current.replaceChildren(picker as unknown as Node);
        setLoaded(true);
      } catch {
        // No picker in this environment (an old browser, a test DOM): the curated grid below is
        // still there, so the composer keeps an emoji button that works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, locale]);

  const grid = (
    <div
      className="tm-pane-emoji"
      role="group"
      aria-label={tOr('ChatMessages.emojiGroup', 'Emoji')}
    >
      {REACTION_SET.map((emoji) => (
        <button
          key={emoji}
          type="button"
          className="tm-pane-emoji__item"
          aria-label={emoji}
          onClick={() => onPick(emoji)}
        >
          {emoji}
        </button>
      ))}
    </div>
  );

  if (mode === 'reaction') return grid;
  return (
    <div className="tm-pane-emoji-mart">
      <div ref={hostRef} />
      {loaded ? null : grid}
    </div>
  );
}
