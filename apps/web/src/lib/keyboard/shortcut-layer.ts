/**
 * Slice 55-12 — the global keyboard shortcut layer, as pure logic so it is testable without a DOM
 * listener: which keys mean what, when the layer must stay silent, and the two-key `g` sequences.
 *
 * Design: Figma `R42 L2-55-12-keyboard` (Product page) — the cheat sheet groups the shortcuts in
 * three sections, and the Arabic frame mirrors the row (label at the start, keys at the end) while
 * the key caps keep their Latin letters.
 *
 * Arabic keyboards: on an Arabic layout the physical G key types `ل`, the slash key types `ظ` and
 * Shift+slash types `؟`. The layer therefore reads the physical key (`event.code`) whenever the
 * typed character is not a Latin letter, so `g h` works in either layout without switching.
 */

export type ShortcutAction =
  'help' | 'goHome' | 'goProjects' | 'goWork' | 'create' | 'search' | 'palette' | 'close';

export type ShortcutSection = 'navigation' | 'actions' | 'help';

export interface ShortcutDefinition {
  readonly action: ShortcutAction;
  readonly section: ShortcutSection;
  /** The keys as the cheat sheet draws them. A sequence is pressed one after the other. */
  readonly keys: readonly string[];
  /** `sequence`: press in turn ("G then H"); `chord`: hold together ("Ctrl + K"). */
  readonly kind: 'single' | 'sequence' | 'chord';
  /** Catalog key for the label, with its English fallback until the fragment is merged. */
  readonly messageKey: string;
  readonly english: string;
}

/** Every shortcut the shell answers, in cheat-sheet order. The cheat sheet renders this list. */
export const SHORTCUTS: readonly ShortcutDefinition[] = [
  {
    action: 'goHome',
    section: 'navigation',
    keys: ['G', 'H'],
    kind: 'sequence',
    messageKey: 'Shortcuts.goHome',
    english: 'Go to My Day',
  },
  {
    action: 'goProjects',
    section: 'navigation',
    keys: ['G', 'P'],
    kind: 'sequence',
    messageKey: 'Shortcuts.goProjects',
    english: 'Go to Projects',
  },
  {
    action: 'goWork',
    section: 'navigation',
    keys: ['G', 'W'],
    kind: 'sequence',
    messageKey: 'Shortcuts.goWork',
    english: 'Go to Work',
  },
  {
    action: 'create',
    section: 'actions',
    keys: ['C'],
    kind: 'single',
    messageKey: 'Shortcuts.create',
    english: 'Create new work',
  },
  {
    action: 'search',
    section: 'actions',
    keys: ['/'],
    kind: 'single',
    messageKey: 'Shortcuts.search',
    english: 'Search',
  },
  {
    // Owned by the command palette's own listener; listed so the sheet is complete.
    action: 'palette',
    section: 'actions',
    keys: ['Ctrl', 'K'],
    kind: 'chord',
    messageKey: 'Shortcuts.palette',
    english: 'Command palette',
  },
  {
    action: 'help',
    section: 'help',
    keys: ['?'],
    kind: 'single',
    messageKey: 'Shortcuts.help',
    english: 'Show this list',
  },
  {
    action: 'close',
    section: 'help',
    keys: ['Esc'],
    kind: 'single',
    messageKey: 'Shortcuts.close',
    english: 'Close a dialog or menu',
  },
];

export const SHORTCUT_SECTIONS: readonly {
  readonly id: ShortcutSection;
  readonly messageKey: string;
  readonly english: string;
}[] = [
  { id: 'navigation', messageKey: 'Shortcuts.section.navigation', english: 'Getting around' },
  { id: 'actions', messageKey: 'Shortcuts.section.actions', english: 'Doing things' },
  { id: 'help', messageKey: 'Shortcuts.section.help', english: 'Help' },
];

/** How long the layer waits for the second key of a `g` sequence. */
export const SEQUENCE_TIMEOUT_MS = 1500;

const SEQUENCE_TARGETS: Readonly<Record<string, ShortcutAction>> = {
  h: 'goHome',
  p: 'goProjects',
  w: 'goWork',
};

const SINGLE_KEYS: Readonly<Record<string, ShortcutAction>> = {
  '?': 'help',
  c: 'create',
  '/': 'search',
  esc: 'close',
};

/** The subset of a `KeyboardEvent` the layer reads. */
export interface KeyInput {
  readonly key: string;
  readonly code?: string;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly isComposing?: boolean;
}

/**
 * The layout-independent token for a key press: a lower-case Latin letter, `/`, `?` or `esc`, or
 * null for anything the layer does not answer (including every press with Ctrl, Meta or Alt held,
 * which belongs to the browser, the OS or the command palette).
 */
export function keyToken(input: KeyInput): string | null {
  if (input.ctrlKey || input.metaKey || input.altKey || input.isComposing) return null;
  if (input.key === 'Escape' || input.key === 'Esc') return 'esc';
  if (input.key === '?' || input.key === '؟') return '?';
  if (input.code === 'Slash') return input.shiftKey ? '?' : '/';
  if (input.key === '/') return '/';
  if (/^[a-z]$/iu.test(input.key)) return input.shiftKey ? null : input.key.toLowerCase();
  // A non-Latin layout (Arabic): read the physical key instead.
  const physical = /^Key([A-Z])$/u.exec(input.code ?? '');
  if (physical && !input.shiftKey) return (physical[1] as string).toLowerCase();
  return null;
}

/**
 * Whether the key press happened while the person is typing — in a text field, a select, or a rich
 * editor. The layer must never steal a letter someone meant to type.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  const element = target as HTMLElement;
  const tag = element.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = ((element as HTMLInputElement).type || 'text').toLowerCase();
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file'].includes(
      type,
    );
  }
  if (element.isContentEditable) return true;
  return (
    element.closest(
      `[contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="searchbox"], [${TYPING_SURFACE_ATTRIBUTE}]`,
    ) !== null
  );
}

/**
 * Marks a writing surface (the doc editor's sheet, its toolbar): a letter pressed anywhere inside it
 * is typing, never a page shortcut.
 */
export const TYPING_SURFACE_ATTRIBUTE = 'data-tm-typing-surface';

/**
 * B-N2 (live check fd145807): whether a single-key shortcut must stay quiet. Besides a key typed in
 * a field, that is a key that reaches the page itself (`<body>` or `<main tabindex=-1>`) while a
 * writing surface is open: focus is on its way into the editor, or a click just missed it, and
 * the person is still typing. A shortcut there jumped to My Day and the doc text was lost.
 */
export function isQuietForShortcuts(
  target: EventTarget | null,
  doc: Pick<Document, 'querySelector' | 'body'> | null = typeof document === 'undefined'
    ? null
    : document,
): boolean {
  if (isTypingTarget(target)) return true;
  if (doc === null) return false;
  const element = target as HTMLElement | null;
  const onPage =
    element === null ||
    element === doc.body ||
    (typeof element.tagName === 'string' && element.tagName === 'MAIN') ||
    (typeof element.tagName === 'string' && element.tagName === 'HTML');
  return onPage && doc.querySelector(`[${TYPING_SURFACE_ATTRIBUTE}]`) !== null;
}

/**
 * The sequence state machine. `feed` takes one token and returns the action it completes, if any.
 * `g` starts a sequence; the next key within {@link SEQUENCE_TIMEOUT_MS} finishes or abandons it.
 */
export class ShortcutMatcher {
  private pendingSince: number | null = null;

  get pending(): boolean {
    return this.pendingSince !== null;
  }

  reset(): void {
    this.pendingSince = null;
  }

  feed(token: string | null, now: number): ShortcutAction | null {
    if (this.pendingSince !== null) {
      const fresh = now - this.pendingSince <= SEQUENCE_TIMEOUT_MS;
      this.pendingSince = null;
      if (fresh && token !== null && SEQUENCE_TARGETS[token]) return SEQUENCE_TARGETS[token];
      if (fresh || token === null) return token === 'esc' ? 'close' : null;
      // A stale `g`: treat this key as a fresh press.
    }
    if (token === null) return null;
    if (token === 'g') {
      this.pendingSince = now;
      return null;
    }
    return SINGLE_KEYS[token] ?? null;
  }
}
