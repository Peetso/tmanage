import { describe, expect, it } from 'vitest';
import { sanitizeSvg, SVG_MAX_ELEMENTS, SVG_MAX_INPUT_CHARS } from './svg-sanitizer.js';

/** C6 — the company-logo SVG sanitiser: what it strips, and what it refuses. */

const CLEAN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#1d4ed8"/></svg>';

function clean(svg: string): string {
  const result = sanitizeSvg(svg);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.svg;
}

describe('sanitizeSvg', () => {
  it('keeps a clean logo as it is, with nothing removed', () => {
    const result = sanitizeSvg(`<?xml version="1.0"?>\n<!-- made in an editor -->\n${CLEAN}`);
    expect(result).toEqual({ ok: true, svg: CLEAN, removed: [] });
  });

  it('strips <script> with its contents', () => {
    const out = clean(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="4"/></svg>',
    );
    expect(out).not.toContain('script');
    expect(out).not.toContain('alert');
    expect(out).toContain('<circle r="4"/>');
  });

  it('strips event-handler attributes, whatever their case', () => {
    const out = clean(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><path d="M0 0" ONCLICK="y()"/></svg>',
    );
    expect(out.toLowerCase()).not.toContain('onload');
    expect(out.toLowerCase()).not.toContain('onclick');
    expect(out).toContain('<path d="M0 0"/>');
  });

  it('strips external references, including an entity-encoded javascript: href', () => {
    const out = clean(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
        '<image href="https://evil.example/x.png" width="1" height="1"/>' +
        '<use xlink:href="&#106;avascript:alert(1)"/>' +
        '<rect fill="url(https://evil.example/p#a)" style="fill:url(http://x/y)" width="1" height="1"/>' +
        '<use href="#ok"/></svg>',
    );
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('javascript');
    expect(out).not.toContain('http://x');
    expect(out).toContain('<use href="#ok"/>');
  });

  it('strips <foreignObject> and everything inside it', () => {
    const out = clean(
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject><rect width="1" height="1"/></svg>',
    );
    expect(out).not.toContain('foreignObject');
    expect(out).not.toContain('hi');
  });

  it('drops a <style> sheet that imports or links out, keeps a safe one', () => {
    const bad = clean(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://x/y.css);</style><rect width="1" height="1"/></svg>',
    );
    expect(bad).not.toContain('@import');
    const good = clean(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:#000}</style><rect class="a" width="1" height="1"/></svg>',
    );
    expect(good).toContain('<style>.a{fill:#000}</style>');
  });

  it('refuses entity definitions, unknown entities, a non-SVG root and broken markup', () => {
    expect(
      sanitizeSvg('<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"/>'),
    ).toEqual({ ok: false, reason: 'entity_definitions' });
    expect(
      sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text><rect/></svg>'),
    ).toEqual({ ok: false, reason: 'unknown_entity' });
    expect(sanitizeSvg('<html><body/></html>')).toEqual({ ok: false, reason: 'not_svg' });
    expect(sanitizeSvg('<svg><rect></svg>')).toEqual({ ok: false, reason: 'unreadable' });
    expect(sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>')).toEqual(
      { ok: false, reason: 'empty' },
    );
  });
});

describe('sanitizeSvg — bounded work (security audit NV14)', () => {
  const wrap = (inner: string): string =>
    `<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/>${inner}</svg>`;

  it('answers N=64000 self-closing <style/> tags in under 200 ms, with no <style in any output', () => {
    const input = wrap('<style/>'.repeat(64_000));
    expect(input.length).toBeLessThanOrEqual(512 * 1024);
    const started = performance.now();
    const result = sanitizeSvg(input);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(200);
    expect(result).toEqual({ ok: false, reason: 'too_complex' });
    expect(JSON.stringify(result)).not.toContain('<style');
  });

  it('drops self-closing <style/> under the element cap, in linear time', () => {
    const result = sanitizeSvg(wrap('<style/>'.repeat(SVG_MAX_ELEMENTS - 2)));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.svg).not.toContain('<style');
  });

  it('judges many unclosed-looking sheets one by one and still drops an unsafe one', () => {
    const result = sanitizeSvg(
      wrap(
        '<style>.a{fill:#000}</style>'.repeat(3000) +
          '<style>@import url(https://x/y.css);</style>',
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.svg).not.toContain('@import');
      expect(result.svg.split('<style>').length - 1).toBe(3000);
      expect(result.removed).toContain('external reference in <style>');
    }
  });

  it('refuses more elements than the cap, and input longer than the cap', () => {
    expect(sanitizeSvg(wrap('<rect/>'.repeat(SVG_MAX_ELEMENTS)))).toEqual({
      ok: false,
      reason: 'too_complex',
    });
    expect(sanitizeSvg(wrap(' '.repeat(SVG_MAX_INPUT_CHARS)))).toEqual({
      ok: false,
      reason: 'too_complex',
    });
  });

  it('parses a tag with many attributes in linear time', () => {
    const attrs = Array.from({ length: 20_000 }, (_v, i) => ` a${i}="1"`).join('');
    const started = performance.now();
    const result = sanitizeSvg(wrap(`<g${attrs}/>`));
    expect(performance.now() - started).toBeLessThan(500);
    expect(result.ok).toBe(true);
  });
});
