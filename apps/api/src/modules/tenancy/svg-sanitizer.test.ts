import { describe, expect, it } from 'vitest';
import { sanitizeSvg } from './svg-sanitizer.js';

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
