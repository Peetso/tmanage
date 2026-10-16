import { COMMAND_REGISTRY } from '../search/command-registry.js';

/**
 * PRF keyboard shortcuts (x286, module 20) — the pure logic behind the caller's-own shortcut
 * overrides: the fixed action allowlist, the shipped default chords, the chord grammar, and the
 * overlay that resolves stored overrides on top of the defaults.
 *
 * ## The allowlist is the palette's own registry, not a second list
 *
 * {@link ALLOWED_ACTION_KEYS} is derived from the command palette's {@link COMMAND_REGISTRY} (x181):
 * an `action_key` is exactly a command id, so this slice can only ever override an action the palette
 * already declares. Reusing the registry rather than copying it means the two can never drift — adding
 * a command adds a rebindable action, and there is no way to name an action the palette does not know.
 *
 * ## The chord grammar is fixed and validated here
 *
 * A chord is zero or more modifiers (`Ctrl`, `Alt`, `Shift`, `Meta`), each at most once, followed by
 * exactly one key — a single letter or digit, or one named key from {@link NAMED_KEYS}. Validation is
 * pure and lives here so the controller and the store never hold a malformed chord: a bad chord is the
 * client's error (400), not a state the row can reach.
 */

/** The command-palette action ids a member may rebind — exactly the palette's registry (x181). */
export const ALLOWED_ACTION_KEYS: ReadonlySet<string> = new Set(
  COMMAND_REGISTRY.map((command) => command.id),
);

/** The modifiers a chord may carry, in the canonical order a resolved chord is written in. */
export const CHORD_MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
export type ChordModifier = (typeof CHORD_MODIFIERS)[number];

/** The named (non-character) keys a chord may end in, beyond a single letter or digit. */
export const NAMED_KEYS: ReadonlySet<string> = new Set([
  'Enter',
  'Escape',
  'Space',
  'Tab',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

/**
 * The shipped default chord for each command-palette action. Every action id in the registry has an
 * entry; the resolved map overlays stored overrides on top of this. Absence of an override for an
 * action means the action resolves to the chord here.
 */
export const DEFAULT_SHORTCUTS: Readonly<Record<string, string>> = Object.freeze({
  'nav-home': 'Ctrl+Shift+H',
  'nav-inbox': 'Ctrl+Shift+I',
  'nav-chat': 'Ctrl+Shift+C',
  'nav-work': 'Ctrl+Shift+W',
  'nav-calendar': 'Ctrl+Shift+L',
  'nav-docs': 'Ctrl+Shift+D',
  'nav-people': 'Ctrl+Shift+P',
  'nav-insights': 'Ctrl+Shift+N',
  'capture-new': 'Ctrl+Shift+J',
  'act-search': 'Ctrl+K',
  'act-clear-recent': 'Ctrl+Shift+Backspace',
});

/** One resolved shortcut in the read-back map: an action, its default, its effective chord. */
export interface ResolvedShortcutView {
  readonly actionKey: string;
  readonly title: string;
  readonly defaultChord: string;
  readonly chord: string;
  readonly overridden: boolean;
}

const TITLE_BY_ACTION: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(COMMAND_REGISTRY.map((command) => [command.id, command.title])),
);

/** Whether `actionKey` is a rebindable command-palette action. */
export function isKnownActionKey(actionKey: string): boolean {
  return ALLOWED_ACTION_KEYS.has(actionKey);
}

/**
 * Whether `chord` matches the fixed grammar: zero or more distinct modifiers in any order joined by
 * `+`, then exactly one key (a single letter/digit or a {@link NAMED_KEYS} name). Pure; no side
 * effects. A chord that is empty, has a repeated modifier, an unknown modifier, or a malformed key is
 * rejected.
 */
export function isValidChord(chord: unknown): chord is string {
  if (typeof chord !== 'string' || chord.length === 0 || chord.length > 64) {
    return false;
  }
  const parts = chord.split('+');
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);

  const seen = new Set<string>();
  for (const mod of mods) {
    if (!CHORD_MODIFIERS.includes(mod as ChordModifier) || seen.has(mod)) {
      return false;
    }
    seen.add(mod);
  }

  if (key === undefined) {
    return false;
  }
  return /^[A-Za-z0-9]$/.test(key) || NAMED_KEYS.has(key);
}

/**
 * The resolved shortcut map: every registry action, its shipped default, and its effective chord —
 * the override where the member has stored one, the default otherwise. Ordered by the registry so the
 * screen renders a stable table. `overrides` is a map of `actionKey -> chord`; unknown keys in it (a
 * default that was later removed from the registry) are ignored, never surfaced.
 */
export function resolveShortcuts(overrides: ReadonlyMap<string, string>): ResolvedShortcutView[] {
  return COMMAND_REGISTRY.map((command) => {
    const defaultChord = DEFAULT_SHORTCUTS[command.id] ?? '';
    const override = overrides.get(command.id);
    return {
      actionKey: command.id,
      title: TITLE_BY_ACTION[command.id] ?? command.id,
      defaultChord,
      chord: override ?? defaultChord,
      overridden: override !== undefined,
    };
  });
}
