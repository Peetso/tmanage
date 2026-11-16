import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StateCapsule } from '../src/components/index.js';

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/styles/components.css'),
  'utf8',
);

/** The declarations of one exact selector's first rule block. */
function rule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `${selector} rule`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

/**
 * 52-13 fix 7 — in Arabic the capsule's shape sat after the word. The shape is now always the
 * first item on the inline axis and the capsule uses logical sides only, so it sits at the start
 * of the label in both directions: left of "Paid", right of "مدفوعة".
 */
describe('StateCapsule direction (52-13 fix 7)', () => {
  it('renders the shape before the word, hidden from a screen reader', () => {
    const { container } = render(
      <div dir="rtl">
        <StateCapsule state="blocked" glyph="!">
          متأخرة 3 أيام
        </StateCapsule>
      </div>,
    );
    const capsule = container.querySelector('.tm-state-capsule');
    const first = capsule?.firstElementChild;
    expect(first?.className).toBe('tm-state-capsule__glyph');
    expect(first?.getAttribute('aria-hidden')).toBe('true');
    expect(capsule?.textContent).toBe('!متأخرة 3 أيام');
  });

  it('pins the shape to the inline start and uses logical sides only', () => {
    expect(rule('.tm-state-capsule__glyph')).toMatch(/order:\s*-1;/u);
    const capsule = rule('.tm-state-capsule');
    expect(capsule).toMatch(/padding-inline:/u);
    expect(capsule).not.toMatch(
      /(?:padding|margin)(?:-left|-right)?:\s*\S+\s+\S+|(?:-left|-right):/u,
    );
  });
});
