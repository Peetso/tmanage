import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { categoryOf, declarations, findLiterals, sizeLiterals, violations } from './design-tokens.mjs';

describe('design-tokens lint (ADR-0016)', () => {
  it('fails on a planted 9px label and a 15px-padded button in a file with no baseline', () => {
    const css = `
      .tm-new-label { font-size: 9px; line-height: 12px; }
      .tm-new-button { min-block-size: 36px; padding: 0 15px; border-radius: 999px; }
    `;
    const found = findLiterals(css);
    assert.deepEqual(
      found.map((f) => `${f.property}: ${f.value}`),
      ['font-size: 9px', 'min-block-size: 36px', 'padding: 0 15px'],
    );
    const bad = violations(new Map([['apps/web/src/new.css', found]]), {});
    assert.equal(bad.length, 1);
    assert.equal(bad[0].allowed, 0);
  });

  it('lets a file that only uses tokens through', () => {
    const css = `.tm-ok { font-size: var(--t-app-ui); padding: var(--s2) var(--inset-control);
      block-size: var(--app-control); gap: var(--s2); margin: 0; }`;
    assert.deepEqual(findLiterals(css), []);
  });

  it('holds a file to its baseline: equal passes, one more fails', () => {
    const found = findLiterals('.a { font-size: 13px; } .b { gap: 6px; }');
    assert.equal(violations(new Map([['x.css', found]]), { 'x.css': 2 }).length, 0);
    assert.equal(violations(new Map([['x.css', found]]), { 'x.css': 1 }).length, 1);
  });

  it('closes the custom-property loophole but leaves non-size custom properties alone', () => {
    const found = findLiterals(
      '.a { --label-size: 13px; --shadow: 0 4px 12px rgb(0 0 0 / 10%); --tint: #fff; }',
    );
    assert.deepEqual(
      found.map((f) => f.property),
      ['--label-size'],
    );
  });

  it('ignores hairlines, zero, media-query preludes, comments and strings', () => {
    const css = `/* font-size: 40px */
      @media (max-width: 900px) { .a { padding: 1px 2px; margin: 0; content: "12px"; } }
      .b { border-width: 13px; inline-size: 300px; }`;
    assert.deepEqual(findLiterals(css), []);
  });

  it('reads rem as 16px per rem and keeps line numbers', () => {
    assert.deepEqual(sizeLiterals('0.75rem 2px'), [{ text: '0.75rem', px: 12 }]);
    const [d] = declarations('.a {\n  color: red;\n  font-size: 13px;\n}');
    assert.equal(d.line, 2);
    const sized = declarations('.a {\n  color: red;\n  font-size: 13px;\n}')[1];
    assert.equal(sized.line, 3);
  });

  it('buckets each property for the report', () => {
    assert.equal(categoryOf('font-size'), 'font-size');
    assert.equal(categoryOf('min-block-size'), 'height');
    assert.equal(categoryOf('padding-inline'), 'padding');
    assert.equal(categoryOf('margin-block-start'), 'margin');
    assert.equal(categoryOf('row-gap'), 'gap');
    assert.equal(categoryOf('--x'), 'custom-property');
  });
});
