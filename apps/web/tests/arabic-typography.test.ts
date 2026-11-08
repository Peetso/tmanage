import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * R36 F3: Arabic text drew in whatever face the machine had, at weights and leading that did not
 * match the English. These pin the three central rules that make the two scripts agree.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(HERE, '../src/app');
const GLOBALS_CSS = readFileSync(join(APP_DIR, 'globals.css'), 'utf8');
const BASE_CSS = readFileSync(join(HERE, '../../../packages/ui/src/styles/base.css'), 'utf8');
const ALEXANDRIA = [...GLOBALS_CSS.matchAll(/@font-face\s*\{[^}]*\}/g)]
  .map((m) => m[0])
  .filter((face) => face.includes("font-family: 'Alexandria'"));

function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

describe('Arabic typography', () => {
  it('self-hosts Alexandria with no face covering 401-599, so Medium draws as Regular', () => {
    expect(ALEXANDRIA).toHaveLength(2);
    const ranges = ALEXANDRIA.map((face) => /font-weight:\s*([^;]+);/.exec(face)?.[1]);
    expect(ranges).toEqual(['100 400', '600 900']);
    for (const face of ALEXANDRIA) {
      const url = /url\('([^']+)'\)/.exec(face)?.[1] ?? '';
      expect(url).toBe('../fonts/Alexandria-Variable.ttf');
      expect(readFileSync(join(APP_DIR, url)).readUInt32BE(0)).toBe(0x00010000);
    }
    expect(existsSync(join(APP_DIR, '../fonts/Alexandria-OFL.txt'))).toBe(true);
  });

  it('opens the scale leading to the Arabic/Doc styles under :lang(ar)', () => {
    const lines = rule(BASE_CSS, ':root:lang(ar)');
    expect(lines).toContain('--t-heading-page-line: 53px;');
    expect(lines).toContain('--t-ui-md-line: 21px;');
    expect(lines).toContain('--t-caption-line: 18px;');
  });

  it('forces zero tracking on Arabic over every component rule', () => {
    expect(rule(BASE_CSS, ':lang(ar) *')).toContain('letter-spacing: 0 !important;');
  });

  it('gives Arabic letters in mono labels the Arabic face, after Geist Mono', () => {
    expect(BASE_CSS).toMatch(/:root:lang\(ar\) \{\s*--font-mono:\s*'Geist Mono', 'Alexandria',/);
  });
});
