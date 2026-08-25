import { describe, expect, it } from 'vitest';
import {
  parseCustomProperties,
  readDesignTokensCss,
  readDesignTokensJson,
  readPackageTokensCss,
} from './design-source.js';
import {
  border,
  colorDark,
  colorLight,
  density,
  focus,
  layout,
  motion,
  orb,
  radius,
  space,
  typeArabic,
  typeFamily,
  typeScale,
} from '../src/tokens/tokens.js';

/**
 * The token package is a copy of an artifact it is not allowed to edit, and a copy with no
 * check against its source is a fork with a delay on it. These tests are that check, and
 * they run in both directions: nothing may be missing, and nothing may be added that the
 * export does not contain.
 */
describe('the TypeScript token module against the design export tokens.json', () => {
  const json = readDesignTokensJson() as {
    color: { light: unknown; dark: unknown };
    type: { family: unknown; scale: unknown; arabic: unknown };
    space: unknown;
    radius: unknown;
    orb: unknown;
    border: unknown;
    focus: unknown;
    layout: unknown;
    motion: unknown;
    density: unknown;
  };

  it('carries the light palette exactly', () => {
    expect(colorLight).toEqual(json.color.light);
  });

  it('carries the dark palette exactly', () => {
    expect(colorDark).toEqual(json.color.dark);
  });

  it('carries the type families, scale and Arabic factors exactly', () => {
    expect(typeFamily).toEqual(json.type.family);
    expect(typeScale).toEqual(json.type.scale);
    expect(typeArabic).toEqual(json.type.arabic);
  });

  it('carries the geometry scales exactly', () => {
    expect(space).toEqual(json.space);
    expect(radius).toEqual(json.radius);
    expect(orb).toEqual(json.orb);
    expect(border).toEqual(json.border);
  });

  it('carries focus, layout, motion and density exactly', () => {
    expect(focus).toEqual(json.focus);
    expect(layout).toEqual(json.layout);
    expect(motion).toEqual(json.motion);
    expect(density).toEqual(json.density);
  });
});

describe('the packaged stylesheet against the design export tokens.css', () => {
  const source = parseCustomProperties(readDesignTokensCss());
  const packaged = parseCustomProperties(readPackageTokensCss());

  it('declares every selector the export declares', () => {
    expect([...packaged.keys()]).toEqual(expect.arrayContaining([...source.keys()]));
  });

  it.each([...source.keys()])('agrees with the export on every value in %s', (selector) => {
    const expected = source.get(selector);
    const actual = packaged.get(selector);

    expect(actual, `selector ${selector} is missing from the packaged stylesheet`).toBeDefined();

    for (const [property, value] of expected ?? []) {
      expect(actual?.get(property), `${selector} { ${property} }`).toBe(value);
    }
  });

  /**
   * The export's stylesheet is a subset of its own JSON: it omits the orb sizes, the type
   * scale, the density compositions and two space steps. The package declares them so a
   * component can reach them as custom properties, and this test pins the additions to a
   * named list so a future one has to be added here first — an accidental token cannot
   * appear by being typed into the stylesheet.
   */
  it('adds only the properties named here, and only where tokens.json backs them', () => {
    const sourceRoot = source.get(':root') ?? new Map<string, string>();
    const packagedRoot = packaged.get(':root') ?? new Map<string, string>();

    const added = [...packagedRoot.keys()].filter((property) => !sourceRoot.has(property));

    expect(added.sort()).toEqual(
      [
        // tokens.json `space` — the export's stylesheet stops at --s16.
        '--s20',
        '--s24',
        // tokens.json `orb`
        '--orb-compact',
        '--orb-default',
        '--orb-comfortable',
        '--orb-navigation',
        '--orb-feature',
        '--orb-hero',
        // tokens.json `layout` — the compact rail, the minimum context rail, the doc column.
        '--rail-compact',
        '--context-rail-min',
        '--doc',
        // tokens.json `type.scale`, one size and one line-height per role.
        '--t-display-xl',
        '--t-display-xl-line',
        '--t-display-lg',
        '--t-display-lg-line',
        '--t-display-metric',
        '--t-display-metric-line',
        '--t-heading-page',
        '--t-heading-page-line',
        '--t-heading-section',
        '--t-heading-section-line',
        '--t-heading-card',
        '--t-heading-card-line',
        '--t-body-lg',
        '--t-body-lg-line',
        '--t-body-md',
        '--t-body-md-line',
        '--t-ui-md',
        '--t-ui-md-line',
        '--t-ui-sm',
        '--t-ui-sm-line',
        '--t-caption',
        '--t-caption-line',
        // tokens.json `density` — the default composition, restated per density below.
        '--row',
        '--control',
        '--surface-radius',
      ].sort(),
    );

    expect(packagedRoot.get('--s20')).toBe(space['20']);
    expect(packagedRoot.get('--s24')).toBe(space['24']);
    expect(packagedRoot.get('--orb-compact')).toBe(orb.compact);
    expect(packagedRoot.get('--orb-hero')).toBe(orb.hero);
    expect(packagedRoot.get('--rail-compact')).toBe(layout.orbitalRailCompact);
    expect(packagedRoot.get('--context-rail-min')).toBe(layout.contextRailMin);
    expect(packagedRoot.get('--doc')).toBe(layout.docWidth);
    expect(packagedRoot.get('--t-heading-page')).toBe(`${typeScale['heading.page'].size}px`);
    expect(packagedRoot.get('--t-heading-page-line')).toBe(`${typeScale['heading.page'].line}px`);
    expect(packagedRoot.get('--t-caption')).toBe(`${typeScale.caption.size}px`);
  });

  it.each(['editorial', 'balanced', 'operational'] as const)(
    'declares the %s density exactly as tokens.json does',
    (name) => {
      const declarations = packaged.get(`[data-density=${name}]`);
      expect(declarations, `[data-density=${name}] is missing`).toBeDefined();
      expect(declarations?.get('--row')).toBe(density[name].row);
      expect(declarations?.get('--control')).toBe(density[name].control);
    },
  );
});
