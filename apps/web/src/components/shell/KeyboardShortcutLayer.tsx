'use client';

import { useEffect, useRef, useState } from 'react';
import { OPEN_COMMAND_PALETTE_EVENT } from '../screens/CommandPalette';
import {
  ShortcutMatcher,
  isQuietForShortcuts,
  keyToken,
  type ShortcutAction,
} from '../../lib/keyboard/shortcut-layer';
import { ShortcutCheatSheet } from './ShortcutCheatSheet';

/** The window event any control may dispatch to open the cheat sheet (e.g. a Help menu entry). */
export const OPEN_SHORTCUTS_EVENT = 'tm:open-shortcuts';

export interface KeyboardShortcutLayerProps {
  organizationSlug: string;
  /** Test seam: where a navigation shortcut goes. Defaults to a real page load. */
  navigate?: (path: string) => void;
  /** Test seam: the clock the `g` sequence is timed against. */
  now?: () => number;
}

function assign(path: string): void {
  if (typeof window !== 'undefined') window.location.assign(path);
}

/** Another modal (command palette, More sheet, a confirm dialog) is open and owns the keyboard. */
function otherModalOpen(): boolean {
  return document.querySelector('[aria-modal="true"]:not([data-shortcut-sheet])') !== null;
}

/**
 * **The global keyboard shortcut layer (slice 55-12).** Mounted once by `AppShell`.
 *
 * `?` opens the cheat sheet, `g h` / `g p` / `g w` go to My Day, Projects and Work, `c` opens quick
 * capture, `/` opens search (the command palette), Escape closes the sheet. It never fires while
 * the person types (inputs, selects, rich editors), never with Ctrl/Meta/Alt held, never when
 * another handler already took the key, and stays out of the way while another modal is open.
 * Letters are read by physical key on a non-Latin layout, so the same keys work in Arabic.
 */
export function KeyboardShortcutLayer({
  organizationSlug,
  navigate = assign,
  now = Date.now,
}: KeyboardShortcutLayerProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const matcher = useRef(new ShortcutMatcher());
  const openRef = useRef(false);
  useEffect(() => {
    openRef.current = sheetOpen;
  }, [sheetOpen]);

  useEffect(() => {
    const base = `/${organizationSlug}`;
    const run = (action: ShortcutAction): boolean => {
      if (openRef.current) {
        if (action === 'close' || action === 'help') {
          openRef.current = false;
          setSheetOpen(false);
          return true;
        }
        return false;
      }
      switch (action) {
        case 'help':
          openRef.current = true;
          setSheetOpen(true);
          return true;
        case 'goHome':
          navigate(`${base}/home`);
          return true;
        case 'goProjects':
          navigate(`${base}/projects/portfolio`);
          return true;
        case 'goWork':
          navigate(`${base}/work`);
          return true;
        case 'create':
          navigate(`${base}/capture`);
          return true;
        case 'search':
          window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT));
          return true;
        default:
          // `close` with nothing of ours open, and `palette` (the palette's own listener).
          return false;
      }
    };

    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat) return;
      if (isQuietForShortcuts(event.target)) {
        matcher.current.reset();
        return;
      }
      if (!openRef.current && otherModalOpen()) {
        matcher.current.reset();
        return;
      }
      const action = matcher.current.feed(keyToken(event), now());
      if (action !== null && run(action)) event.preventDefault();
    }
    function onOpen() {
      setSheetOpen(true);
    }
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    };
  }, [organizationSlug, navigate, now]);

  return sheetOpen ? <ShortcutCheatSheet onClose={() => setSheetOpen(false)} /> : null;
}
