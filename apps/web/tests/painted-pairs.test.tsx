import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/react';
import { AA_NON_TEXT, AA_NORMAL_TEXT, contrastRatio } from '@tmanage/ui';
import { describe, expect, it } from 'vitest';
import { IdentityShell } from '../src/components/shell/IdentityShell';

/**
 * The pairs the stylesheets actually paint.
 *
 * `contrast.test.ts` next door checks colour pairings that were transcribed into it by
 * hand — a foreground token and a background token, named in a literal, measured, asserted.
 * That file is correct about every pair it lists and blind to every pair it does not, which
 * is precisely how D14 shipped: it asserts `--tm-inverted-muted` against
 * `--tm-inverted-ground` and gets 8.04:1, while the stylesheet was painting that same token
 * on `--paper-150` at 1.40:1. A pairing nobody thought to list is unchecked, and a hand-
 * written list cannot fail when the stylesheet changes underneath it.
 *
 * This file takes the pairs from the source instead. Nothing below names a colour:
 *
 * - the **values** are read out of `packages/ui/src/styles/tokens.css` and resolved through
 *   the same `var()` chains the browser would follow, once per theme;
 * - the **foreground and background declarations** are read out of the rule bodies in
 *   `globals.css` and `components.css`, so editing a declaration moves the assertion with
 *   it rather than leaving it stale;
 * - the **nesting** — which background a foreground actually lands on — comes from the
 *   rendered DOM where a shell can be mounted (the identity footer, C-04), and otherwise
 *   from a small declared map of element to the surface that paints behind it. That map is
 *   the one hand-written thing left here, and it is checked: a use of an inverted token
 *   that is not in the map fails the suite rather than passing unexamined.
 *
 * Scope, stated plainly because the gap matters more than the coverage: this file proves the
 * tokens touched by C-01 to C-04 of the 2026-09-12 accessibility audit. It is not a
 * substitute for `color-contrast` running in a browser, which `tests/axe.ts` still disables
 * over all thirteen screens because jsdom does not lay out or paint. See the note at the
 * foot of this file for what remains unproven.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

const GLOBALS = readFileSync(join(HERE, '../src/app/globals.css'), 'utf8');
const TOKENS = readFileSync(join(HERE, '../../../packages/ui/src/styles/tokens.css'), 'utf8');
const COMPONENTS = readFileSync(
  join(HERE, '../../../packages/ui/src/styles/components.css'),
  'utf8',
);
const BASE = readFileSync(join(HERE, '../../../packages/ui/src/styles/base.css'), 'utf8');

/* ── Reading the stylesheets ──────────────────────────────────────────────────── */

/**
 * The body of the first rule whose selector list ends with `selector`.
 *
 * Brace-counted rather than regex-matched, so a nested `@media` block comes back whole and
 * can be searched again. `selector` is matched as the literal text immediately before the
 * opening brace, which is why a grouped rule is addressed by its **last** selector: prettier
 * writes `.tm-checkbox,\n.tm-radio {`, and `.tm-radio` is the half adjacent to the brace.
 */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no rule for \`${selector}\``);

  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated rule for \`${selector}\``);
}

/** The declarations of one rule body, with comments and any nested rules removed. */
function declarations(body: string): Map<string, string> {
  const flat = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{[^{}]*\}/g, '');
  const out = new Map<string, string>();
  for (const statement of flat.split(';')) {
    const at = statement.indexOf(':');
    if (at < 0) continue;
    const property = statement.slice(0, at).trim();
    if (property === '' || property.includes('{') || property.includes('}')) continue;
    out.set(property, statement.slice(at + 1).trim());
  }
  return out;
}

/** The custom properties a rule declares, keyed by property name. */
function customProperties(body: string): Map<string, string> {
  return new Map([...declarations(body)].filter(([property]) => property.startsWith('--')));
}

/**
 * The two theme environments, assembled the way the cascade assembles them: `tokens.css`
 * declares the palette under `:root`, `globals.css` layers the four `--tm-inverted-*`
 * aliases on top, and `[data-theme='dark']` overrides a subset of both. `ruleBody` finds the
 * *first* `:root` in each file, which is the top-level one — `tokens.css`'s second `:root`
 * is nested inside the `prefers-reduced-motion` query and carries durations only.
 */
const LIGHT_ENV = new Map([
  ...customProperties(ruleBody(TOKENS, ':root')),
  ...customProperties(ruleBody(GLOBALS, ':root')),
]);

const DARK_ENV = new Map([
  ...LIGHT_ENV,
  ...customProperties(ruleBody(TOKENS, "[data-theme='dark']")),
  ...customProperties(ruleBody(GLOBALS, "[data-theme='dark']")),
]);

const THEMES = [
  { name: 'light', env: LIGHT_ENV },
  { name: 'dark', env: DARK_ENV },
] as const;

/** Follow a `var()` chain to the literal it ends at, in one theme's environment. */
function resolve(value: string, env: Map<string, string>, depth = 0): string {
  const text = value.trim();
  const reference = /^var\(\s*(--[\w-]+)\s*\)$/.exec(text);
  const property = reference?.[1];
  if (property === undefined) return text;
  if (depth > 10) throw new Error(`\`${value}\` does not terminate`);

  const next = env.get(property);
  if (next === undefined) throw new Error(`\`${property}\` is not declared in this theme`);
  return resolve(next, env, depth + 1);
}

/** A resolved colour, refused unless it really is one. */
function hex(value: string, env: Map<string, string>): string {
  const resolved = resolve(value, env);
  if (!/^#[0-9a-f]{6}$/i.test(resolved)) {
    throw new Error(`\`${value}\` resolves to \`${resolved}\`, which is not a colour`);
  }
  return resolved.toLowerCase();
}

/** A resolved pixel length. Geometry is not themed, so this reads the light environment. */
function px(value: string): number {
  const resolved = resolve(value, LIGHT_ENV);
  const match = /^(\d+(?:\.\d+)?)px$/.exec(resolved);
  if (match === null) {
    throw new Error(`\`${value}\` resolves to \`${resolved}\`, which is not a pixel length`);
  }
  return Number(match[1]);
}

/**
 * The colour out of a shorthand. `border: var(--b-quiet) solid var(--ink-500)` carries a
 * width and a style before the colour, and the colour is always last.
 */
function colorOf(shorthand: string): string {
  const parts = shorthand.match(/var\(\s*--[\w-]+\s*\)|#[0-9a-f]{6}/gi) ?? [];
  const last = parts.at(-1);
  if (last === undefined) throw new Error(`no colour in \`${shorthand}\``);
  return last;
}

function ratio(foreground: string, background: string): number {
  return Number(contrastRatio(foreground, background).toFixed(2));
}

/** The value a rule declares for a property, as written. */
function declared(css: string, selector: string, property: string): string {
  const value = declarations(ruleBody(css, selector)).get(property);
  if (value === undefined) throw new Error(`\`${selector}\` declares no \`${property}\``);
  return value;
}

/* ── C-04: the identity footer, with the nesting taken from the DOM ───────────── */

/** The background `globals.css` declares for a class, if it paints one at all. */
function backgroundOfClass(className: string): string | undefined {
  try {
    return declarations(ruleBody(GLOBALS, `.${className}`)).get('background');
  } catch {
    return undefined;
  }
}

/** Walk up the rendered tree to the nearest ancestor that actually paints a ground. */
function nearestPaintedGround(element: Element): { selector: string; background: string } {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    for (const className of node.classList) {
      const background = backgroundOfClass(className);
      if (background !== undefined) return { selector: `.${className}`, background };
    }
  }
  throw new Error('nothing in the ancestry declares a background');
}

describe('the identity footer (C-04)', () => {
  function footerElement(): Element {
    const { container } = render(
      <IdentityShell screenId="ID-01" eyebrow="Sign in" footer={<a href="/legal">Privacy</a>}>
        <h1>Sign in</h1>
      </IdentityShell>,
    );
    const footer = container.querySelector('.tm-identity__footer');
    if (footer === null) throw new Error('the shell rendered no footer');
    return footer;
  }

  /**
   * The assertion D14 needed and did not have. The foreground comes from the rule, the
   * background comes from whichever ancestor the *rendered shell* paints, and neither is
   * written down here — so moving the footer onto a different surface, or repointing either
   * colour, is caught rather than quietly re-measured against a surface it no longer touches.
   */
  it.each(THEMES)('reads at AA against the surface it is rendered on ($name)', ({ env }) => {
    const ground = nearestPaintedGround(footerElement());

    // The card, not the inverted backdrop behind it. This is the fact D14 got wrong.
    expect(ground.selector).toBe('.tm-identity__card');

    const foreground = hex(colorOf(declared(GLOBALS, '.tm-identity__footer', 'color')), env);
    expect(ratio(foreground, hex(colorOf(ground.background), env))).toBeGreaterThanOrEqual(
      AA_NORMAL_TEXT,
    );
  });

  /** `.tm-identity__footer a { color: inherit }`, so the links carry the same ratio. */
  it('carries its colour to the privacy and support links by inheritance', () => {
    expect(declared(GLOBALS, '.tm-identity__footer a', 'color')).toBe('inherit');
    expect(footerElement().querySelector('a')).not.toBeNull();
  });

  /**
   * The shape of the bug, asserted directly so the token cannot come back. `--tm-inverted-*`
   * is the muted ink for the *inverted* surfaces; on the two paper grounds this application
   * puts cards on, it is unreadable in the shipped light theme. That is not a defect in the
   * token — it is why the token may not be used on paper.
   */
  it.each(['--paper-0', '--paper-150'])(
    'shows why an inverted token may not be used for text on %s',
    (paper) => {
      const muted = hex('var(--tm-inverted-muted)', LIGHT_ENV);
      expect(ratio(muted, hex(`var(${paper})`, LIGHT_ENV))).toBeLessThan(AA_NORMAL_TEXT);
    },
  );
});

/* ── C-04, generalised: every inverted foreground, against its declared ground ── */

/**
 * Every rule in `globals.css` that sets text to an inverted token, mapped to the selector
 * whose background it sits on. The map is hand-written because CSS alone does not carry
 * nesting, but it is not trusted: the first case derives the *count* of such rules from the
 * stylesheet and fails if it does not match. A new inverted foreground — or an old one moved
 * onto paper — therefore has to be added here with its ground, and the ratio is then
 * computed from the real declarations in both themes.
 */
const INVERTED_FOREGROUNDS: ReadonlyArray<readonly [selector: string, ground: string]> = [
  // 2026-10-18 visual rebuild: the rail (`--paper-350`), the portal bar (`--paper-50`) and the
  // docked orbs (`--paper-0`) are paper surfaces in the handoff, so their words left the inverted
  // tokens. HOME-01's black day capsule is the one inverted surface that sets text.
  ['.tm-day-pulse__capsule', '.tm-day-pulse__capsule'],
  ['.tm-day-pulse__slot-time', '.tm-day-pulse__capsule'],
  [".tm-day-pulse__slot[data-state='done'] .tm-day-pulse__slot-label", '.tm-day-pulse__capsule'],
];

describe('inverted foregrounds in globals.css', () => {
  it('are exactly the rules this file knows the ground for', () => {
    const withoutComments = GLOBALS.replace(/\/\*[\s\S]*?\*\//g, '');
    const uses = withoutComments.match(/color:\s*var\(--tm-inverted-[\w-]+\)/g) ?? [];
    expect(uses).toHaveLength(INVERTED_FOREGROUNDS.length);
  });

  it.each(THEMES)('read at AA against their own ground ($name)', ({ env }) => {
    for (const [selector, ground] of INVERTED_FOREGROUNDS) {
      const foreground = hex(colorOf(declared(GLOBALS, selector, 'color')), env);
      const background = hex(colorOf(declared(GLOBALS, ground, 'background')), env);
      expect(ratio(foreground, background), `${selector} on ${ground}`).toBeGreaterThanOrEqual(
        AA_NORMAL_TEXT,
      );
    }
  });
});

/* ── C-02: control boundaries ─────────────────────────────────────────────────── */

/**
 * The control surfaces WCAG 1.4.11 covers, each named by the selector adjacent to its
 * opening brace and paired with the surface its border is seen against.
 *
 * `.tm-field__control` is the text input, and `.tm-select__control` and
 * `.tm-combobox__control` carry that class too, so it stands for all three. The switch is
 * two rows: the thumb against its own fill, and the thumb against the track it travels over,
 * because a thumb that cannot be told from the track does not say which way the switch is
 * thrown.
 *
 * Nothing here names a colour. The border and the background are both read from the rule.
 */
const CONTROL_BOUNDARIES: ReadonlyArray<
  readonly [name: string, selector: string, against: string]
> = [
  ['the text input, select and combobox', '.tm-field__control', '.tm-field__control'],
  // Two states that change the fill and keep the border, so the pair moves under them.
  ['the disabled text input', '.tm-field__control', '.tm-field__control:disabled'],
  ['the read-only text input', '.tm-field__control', '.tm-field__control[readonly]'],
  ['the checkbox and the radio', '.tm-radio', '.tm-radio'],
  ['the switch track', '.tm-switch', '.tm-switch'],
  ['the switch thumb, against its own fill', '.tm-switch::before', '.tm-switch::before'],
  ['the switch thumb, against the track', '.tm-switch::before', '.tm-switch'],
];

describe('control boundaries (C-02)', () => {
  it.each(THEMES)('clear the 3:1 non-text floor in the $name theme', ({ env }) => {
    for (const [name, selector, against] of CONTROL_BOUNDARIES) {
      const border = hex(colorOf(declared(COMPONENTS, selector, 'border')), env);
      const background = hex(colorOf(declared(COMPONENTS, against, 'background')), env);
      expect(ratio(border, background), name).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  /**
   * Why the decorative token is not the control token. `--line-300` is the panel rule and
   * the table row separator, where 1.4.11's decoration exception applies and it is fine. On
   * a control it was 1.71:1 in light and 1.55:1 in dark. Asserted rather than commented, so
   * an edit that reaches back for it has to argue with a failing test.
   */
  it.each(THEMES)('shows why --line-300 is not a control boundary ($name)', ({ env }) => {
    expect(ratio(hex('var(--line-300)', env), hex('var(--paper-0)', env))).toBeLessThan(
      AA_NON_TEXT,
    );
  });

  it('leaves the decorative uses of --line-300 in place', () => {
    // The exception is real: a panel border and a row separator are not control boundaries.
    expect(declared(COMPONENTS, '.tm-inline-alert', 'border')).toContain('--line-300');
  });
});

/* ── C-03: the focus indicator under forced colours ───────────────────────────── */

describe('the focus indicator (C-03)', () => {
  const FOCUS_SELECTOR = ':where(a, button, input, select, textarea, summary, [tabindex])';

  /**
   * What can honestly be checked without a browser, and no more.
   *
   * The base rule suppresses the user agent outline and draws the ring with `box-shadow`.
   * `forced-colors: active` discards author `box-shadow` by specification, so without a
   * fallback there is no focus indicator anywhere in the product in that mode — 2.4.7, and
   * Level A. The fallback is a media block that re-expresses the ring as an `outline`, which
   * forced colours repaints rather than drops.
   *
   * These assertions read the source: the block exists, it covers the same selector, it sets
   * a real outline, and it does not re-suppress it. That is a genuine regression guard —
   * deleting the block, or narrowing it, fails here. It is **not** a proof that a browser
   * paints the ring: jsdom neither evaluates this media query nor paints, and the
   * visual-regression harness renders light, dark and RTL only. Confirming the paint needs a
   * real render in Windows High Contrast, and is recorded as open rather than covered.
   */
  it('falls back to an outline under forced colours', () => {
    const block = ruleBody(BASE, '@media (forced-colors: active)');
    expect(block).toContain(`${FOCUS_SELECTOR}:focus-visible`);

    const outline = declarations(ruleBody(block, `${FOCUS_SELECTOR}:focus-visible`)).get('outline');
    expect(outline).toBeDefined();
    expect(outline).not.toBe('none');
    // A system colour, not an author colour: only the user agent's own foreground is
    // guaranteed to contrast with whatever ground the user has chosen.
    expect(outline).toMatch(/\b(CanvasText|LinkText|Highlight|ButtonText)\b/);
  });

  it('still suppresses the user agent outline normally, which is what needs the fallback', () => {
    const normal = declarations(ruleBody(BASE, `${FOCUS_SELECTOR}:focus-visible`));
    expect(normal.get('outline')).toBe('none');
    expect(normal.get('box-shadow')).toBe('var(--focus-ring)');
  });
});

/* ── C-01: the mobile dock at 320px ───────────────────────────────────────────── */

describe('the mobile navigation dock (C-01)', () => {
  // `responsive-and-desktop.md`: "640–899 Docked Orbs appear, rail hidden". Below that width
  // the rail is not shown at all and the five docked orbs are the primary navigation.
  const MOBILE = ruleBody(GLOBALS, '@media (max-width: 56.19rem)');
  const REFLOW_WIDTH = 320;
  const DOCK_ITEMS = 5;

  it('hides the rail where the dock appears, so one primary navigation is on screen', () => {
    expect(declarations(ruleBody(MOBILE, '.tm-rail')).get('display')).toBe('none');
    expect(declarations(ruleBody(MOBILE, '.tm-mobile-nav')).get('display')).toBe('block');
  });

  /**
   * The arithmetic from the tokens: five orbs and four gaps inside 320px (1.4.10 Reflow),
   * leaving the dock's own inset and padding. The orb is `--orb-comfortable` (44px), which is
   * also the 44px mobile target the responsive spec asks for.
   */
  it('fits every destination and its gaps inside 320px', () => {
    const orb = px(declarations(ruleBody(MOBILE, '.tm-mobile-nav__orb')).get('inline-size') ?? '');
    const gap = px(declarations(ruleBody(MOBILE, '.tm-mobile-nav__list')).get('gap') ?? '');

    expect(orb).toBe(44);
    expect(DOCK_ITEMS * orb + (DOCK_ITEMS - 1) * gap).toBeLessThanOrEqual(
      REFLOW_WIDTH - 2 * 16 - 12,
    );
  });

  it('releases the min-content floor so the row can shrink', () => {
    const item = declarations(ruleBody(MOBILE, '.tm-mobile-nav__list > li'));
    expect(item.get('min-inline-size')).toBe('0');
    expect(item.get('flex')).toBe('1 1 0');
  });

  it('truncates the label instead of widening the dock', () => {
    const label = declarations(ruleBody(MOBILE, '.tm-mobile-nav__label'));
    expect(label.get('overflow')).toBe('hidden');
    expect(label.get('text-overflow')).toBe('ellipsis');
    expect(label.get('white-space')).toBe('nowrap');
  });
});

/**
 * ## What this file does not prove
 *
 * - **Any pairing outside C-02 and C-04.** The pairs above are the ones the audit's two
 *   contrast findings touch. Every other foreground/background combination in
 *   `components.css` — and every combination that exists only once a component is in a state,
 *   `:hover`, `:checked`, `:disabled`, `[data-active]` — is still unchecked here, and still
 *   unchecked by `tests/axe.ts`, whose `color-contrast` rule is disabled over all thirteen
 *   screens because jsdom does not paint.
 * - **Anything that depends on layout.** The C-01 assertions are arithmetic over tokens, not
 *   a measurement. `document.scrollWidth` at a 320px viewport is the real proof, and it needs
 *   a browser.
 * - **Forced colours.** See the note on the C-03 case: the media block is asserted to exist
 *   and to be well formed, never to be painted.
 * - **`[data-contrast='high']` and the dark theme.** Neither is reachable in the product —
 *   `layout.tsx` hard-codes `data-theme="light"` — so every dark figure above is latent
 *   rather than live, and `[data-contrast='high']` is not exercised at all.
 *
 * The cheapest way to close most of this is a browser-based axe run over the thirteen screens
 * the flow tests already mount, with `color-contrast` enabled.
 */
