import axe from 'axe-core';
import { expect } from 'vitest';

/**
 * axe-core against a mounted subtree.
 *
 * `color-contrast` is disabled, and that is a limitation rather than a preference: jsdom
 * does not lay out or paint, so axe cannot sample a rendered pixel and reports the rule as
 * *incomplete*. Leaving it enabled would produce a green result that had checked nothing.
 * The palette is checked arithmetically instead, in `tests/contrast.test.ts`.
 *
 * Everything else axe can do without layout — names, roles, labels, duplicate ids, ARIA
 * validity, nesting — runs here.
 */
export async function expectNoAxeViolations(container: Element): Promise<void> {
  const results = await axe.run(container, {
    rules: {
      'color-contrast': { enabled: false },
      // The primitives are mounted bare, not inside a page, so page-level structure rules
      // have nothing to judge. They belong to the screen tickets (WEB-*), where A11Y-01
      // asks for landmarks, headings and a skip link on a real document.
      region: { enabled: false },
    },
  });

  const summary = results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.html).join(', ')})`,
  );

  expect(summary).toEqual([]);
}
