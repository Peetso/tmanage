import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCustomProperties } from './design-source.js';
import {
  appDensity,
  appInset,
  appLayout,
  appType,
  appTypeArabicPageTitleLine,
  pageGutter,
} from '../src/tokens/app-density.js';

/**
 * Density v2 has two forms, the custom properties in `src/styles/density.css` and the TS
 * constants in `src/tokens/app-density.ts`. Both come from the Figma variables named in
 * `density.css`; this test is what keeps them one decision (DC-2: one value decided in two
 * places), in both directions: every `:root` property of the sheet is accounted for here.
 */
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sheet = parseCustomProperties(
  readFileSync(join(packageRoot, 'src/styles/density.css'), 'utf8'),
);
const root = sheet.get(':root') ?? new Map<string, string>();

const px = (value: number) => `${value}px`;

const expected: Record<string, string> = {
  '--app-control': px(appDensity.control),
  '--app-control-sm': px(appDensity.controlSm),
  '--app-control-lg': px(appDensity.controlLg),
  '--app-row': px(appDensity.row),
  '--app-panel-row': px(appDensity.panelRow),
  '--app-header-row': px(appDensity.headerRow),
  '--target-min': px(appDensity.targetMin),
  '--page-gutter': px(pageGutter.desktop),
  '--app-rail': px(appLayout.rail),
  '--app-context-rail': px(appLayout.contextRail),
  '--properties-panel': px(appLayout.propertiesPanel),
  '--panel-label': px(appLayout.panelLabel),
  '--dialog': px(appLayout.dialog),
  '--inset-control': px(appInset.control),
  '--inset-capsule': px(appInset.capsule),
  '--inset-cell': px(appInset.cell),
  '--inset-card': px(appInset.card),
  '--inset-dialog': px(appInset.dialog),
  '--text-edge-min': px(appInset.textEdgeMin),
  '--app-radius': 'var(--r-control)',
};

const typeNames: Record<keyof typeof appType, string> = {
  pageTitle: 'page-title',
  section: 'section',
  cardTitle: 'card-title',
  body: 'body',
  ui: 'ui',
  uiStrong: 'ui-strong',
  caption: 'caption',
  overline: 'overline',
};

for (const [key, name] of Object.entries(typeNames) as [keyof typeof appType, string][]) {
  expected[`--t-app-${name}`] = px(appType[key].size);
  expected[`--t-app-${name}-line`] = px(appType[key].line);
  expected[`--t-app-${name}-weight`] = String(appType[key].weight);
}

describe('Density v2: density.css against app-density.ts', () => {
  it('declares exactly the tokens the TS module names, no more and no fewer', () => {
    expect([...root.keys()].sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.entries(expected))('%s is %s', (property, value) => {
    expect(root.get(property)).toBe(value);
  });

  it('carries the Figma Layout modes for the gutter (tablet 24, phone 16)', () => {
    const conditional = [...sheet.entries()].filter(([selector]) => selector.startsWith('@media'));
    const gutters = conditional.map(([, props]) => props.get('--page-gutter')).sort();
    expect(gutters).toEqual([px(pageGutter.phone), px(pageGutter.tablet)].sort());
  });

  it('opens the Arabic page-title line to the App AR value', () => {
    expect(sheet.get(':root:lang(ar)')?.get('--t-app-page-title-line')).toBe(
      px(appTypeArabicPageTitleLine),
    );
  });

  it('keeps doc-frame rule 4: no text style below 11px', () => {
    for (const style of Object.values(appType)) expect(style.size).toBeGreaterThanOrEqual(11);
  });
});
