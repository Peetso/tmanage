'use client';

import { Fragment, useEffect, useId, useRef } from 'react';
import { useTOr } from '../../lib/i18n/use-t-or';
import { SHORTCUTS, SHORTCUT_SECTIONS } from '../../lib/keyboard/shortcut-layer';
import type { ShortcutDefinition } from '../../lib/keyboard/shortcut-layer';
import './shortcut-cheat-sheet.css';

export interface ShortcutCheatSheetProps {
  /** Close the sheet. Focus returns to whatever held it when the sheet opened. */
  onClose: () => void;
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * **Keyboard shortcuts cheat sheet (slice 55-12, Figma `R42 L2-55-12-keyboard`).**
 *
 * A modal dialog listing every shortcut of {@link SHORTCUTS} under its section — Getting around,
 * Doing things, Help. Rows are flex in the document's direction, so in Arabic the label sits at
 * the inline start (right) and the keys at the end, and a sequence reads "G ثم H" from the right;
 * the key caps keep their Latin letters, as the Arabic frame draws them.
 *
 * WCAG: focus moves to the close button on open, Tab and Shift+Tab stay inside the dialog (focus
 * trap), and focus returns to the element that opened it on close. Escape is answered by the
 * shortcut layer, which owns the sheet.
 */
export function ShortcutCheatSheet({ onClose }: ShortcutCheatSheetProps) {
  const tOr = useTOr();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      if (previous && typeof previous.focus === 'function' && previous.isConnected) {
        previous.focus();
      }
    };
  }, []);

  // Focus trap: Tab and Shift+Tab wrap inside the dialog.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }
    dialog.addEventListener('keydown', onKeyDown);
    return () => dialog.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="tm-shortcuts__layer">
      <div className="tm-shortcuts__scrim" aria-hidden="true" onClick={onClose} />
      <div
        ref={dialogRef}
        className="tm-shortcuts"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-shortcut-sheet=""
      >
        <div className="tm-shortcuts__header">
          <h2 id={titleId} className="tm-shortcuts__title">
            {tOr('Shortcuts.title', 'Keyboard shortcuts')}
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="tm-shortcuts__close"
            aria-label={tOr('Shortcuts.closeButton', 'Close')}
            onClick={onClose}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <p className="tm-shortcuts__intro">
          {tOr('Shortcuts.intro', 'Shortcuts pause while you type in a field or editor.')}
        </p>
        {SHORTCUT_SECTIONS.map((section) => (
          <section key={section.id} className="tm-shortcuts__section">
            <h3 className="tm-shortcuts__section-title">
              {tOr(section.messageKey, section.english)}
            </h3>
            <ul className="tm-shortcuts__list">
              {SHORTCUTS.filter((shortcut) => shortcut.section === section.id).map((shortcut) => (
                <li key={shortcut.action} className="tm-shortcuts__row">
                  <span className="tm-shortcuts__label">
                    {tOr(shortcut.messageKey, shortcut.english)}
                  </span>
                  <ShortcutKeys shortcut={shortcut} then={tOr('Shortcuts.then', 'then')} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function ShortcutKeys({ shortcut, then }: { shortcut: ShortcutDefinition; then: string }) {
  return (
    <span className="tm-shortcuts__keys">
      {shortcut.keys.map((key, index) => (
        <Fragment key={key}>
          {index > 0 ? (
            <span className="tm-shortcuts__joiner">{shortcut.kind === 'chord' ? '+' : then}</span>
          ) : null}
          <kbd className="tm-shortcuts__key">{key}</kbd>
        </Fragment>
      ))}
    </span>
  );
}
