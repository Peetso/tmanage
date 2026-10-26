import { describe, expect, it } from 'vitest';
import { sanitizeSvg, SVG_MAX_INPUT_CHARS } from './svg-sanitizer.js';

/**
 * Security audit run 2, V1 / NV14: the logo sanitiser's work must stay linear in the input.
 *
 * Measured on the code before this change (same machine, Node 22): the crafted logo below
 * (a 370 000-quote attribute, then ~8 500 `<style>a{}</style>`, 512 KiB) took 12 468 ms, the
 * same with refused sheets (`<style>@import</style>`) 7 815 ms, and a 512 KiB flood of `url(`
 * with no `)` 56 973 ms inside a `<style>` and 50 042 ms inside a `style` attribute. After it:
 * 157 ms, 142 ms, 7 ms and 124 ms.
 */

const OPEN = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/>';
const QUOTES = 370_000;
const LIMIT_MS = 500;

/** One early element whose single-quoted attribute holds ~370K `"` (6 output chars each). */
function crafted(unit: string): string {
  const head = `<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" data-x='${'"'.repeat(QUOTES)}'/>`;
  const tail = '</svg>';
  const count = Math.min(
    9_900,
    Math.floor((SVG_MAX_INPUT_CHARS - head.length - tail.length) / unit.length),
  );
  return head + unit.repeat(count) + tail;
}

function timed(svg: string): { ms: number; result: ReturnType<typeof sanitizeSvg> } {
  const started = performance.now();
  const result = sanitizeSvg(svg);
  return { ms: performance.now() - started, result };
}

describe('sanitizeSvg — linear work on crafted logos (V1 / NV14, run 2)', () => {
  it.each([
    ['empty sheets', '<style></style>'],
    ['kept sheets', '<style>a{}</style>'],
    ['refused sheets', '<style>@import</style>'],
  ])('a 370K-quote attribute then ~9 900 %s finishes under 500 ms', (_label, unit) => {
    const svg = crafted(unit);
    expect(svg.length).toBeLessThanOrEqual(SVG_MAX_INPUT_CHARS);
    const { ms, result } = timed(svg);
    expect(result.ok).toBe(true);
    expect(ms).toBeLessThan(LIMIT_MS);
    if (result.ok) expect(result.svg.includes('@import')).toBe(false);
  });

  it('a 512 KiB flood of `url(` with no `)` in a <style> finishes under 500 ms and is dropped', () => {
    const tail = '</style></svg>';
    const head = `${OPEN}<style>`;
    const svg =
      head +
      'url('.repeat(Math.floor((SVG_MAX_INPUT_CHARS - head.length - tail.length) / 4)) +
      tail;
    expect(svg.length).toBeLessThanOrEqual(SVG_MAX_INPUT_CHARS);
    const { ms, result } = timed(svg);
    expect(ms).toBeLessThan(LIMIT_MS);
    expect(result).toEqual({
      ok: true,
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
      removed: ['external reference in <style>'],
    });
  });

  it('the same flood in a style attribute finishes under 500 ms and the attribute is dropped', () => {
    const head = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" style="';
    const tail = '"/></svg>';
    const svg =
      head +
      'url('.repeat(Math.floor((SVG_MAX_INPUT_CHARS - head.length - tail.length) / 4)) +
      tail;
    const { ms, result } = timed(svg);
    expect(ms).toBeLessThan(LIMIT_MS);
    expect(result).toEqual({
      ok: true,
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
      removed: ['external reference in style'],
    });
  });

  it('a long whitespace run inside url( … ) is judged in linear time', () => {
    const head = `${OPEN}<style>a{fill:url(#a`;
    const tail = "'x)}</style></svg>";
    const svg = head + ' '.repeat(SVG_MAX_INPUT_CHARS - head.length - tail.length) + tail;
    const { ms, result } = timed(svg);
    expect(ms).toBeLessThan(LIMIT_MS);
    expect(result.ok && result.svg.includes('<style>')).toBe(false);
  });

  it('still cuts a refused <style> out whole, between kept output on both sides', () => {
    const result = sanitizeSvg(
      `${OPEN}<style>a{fill:url(#ok)}</style>` +
        '<style>b{fill:url(https://evil.example/x)}<g/></style>' +
        '<circle r="1"/><style>c{fill:url(http://x</style></svg>',
    );
    expect(result).toEqual({
      ok: true,
      svg:
        '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/>' +
        '<style>a{fill:url(#ok)}</style><circle r="1"/></svg>',
      removed: ['external reference in <style>', 'external reference in <style>'],
    });
  });

  it('keeps the fragment url forms the old pattern kept', () => {
    for (const css of ['url(#a)', 'url( "#a" )', "url('#a')", 'URL (#a)', 'url(\n#a\n)']) {
      const result = sanitizeSvg(`${OPEN}<style>p{fill:${css}}</style></svg>`);
      expect(result.ok && result.removed).toEqual([]);
    }
    for (const css of ["url(#a'')", 'url(#a"b)', 'url(http://x/#a)', 'url(', 'url(#a']) {
      const result = sanitizeSvg(`${OPEN}<style>p{fill:${css}}</style></svg>`);
      expect(result.ok && result.removed).toEqual(['external reference in <style>']);
    }
  });
});
