import axe from 'axe-core';
import { expect } from 'vitest';

/**
 * axe-core against a mounted screen.
 *
 * This is `packages/ui`'s helper with one rule turned back on. There, `region` is disabled
 * because a primitive is mounted bare and page-level structure rules have nothing to judge.
 * Here the unit under test *is* a page, so `region` stays enabled: `A11Y-01` in
 * `27-TEST-CATALOG` asks for landmarks, headings and a skip link on a real document, and this
 * is the ticket that owes them.
 *
 * `color-contrast` remains disabled and remains a limitation rather than a preference: jsdom
 * does not lay out or paint, so axe reports the rule as *incomplete* and a green result would
 * have checked nothing. The palette is checked arithmetically in `tests/contrast.test.ts`.
 */
export async function expectNoAxeViolations(container: Element): Promise<void> {
  const results = await axe.run(container, {
    rules: {
      'color-contrast': { enabled: false },
    },
  });

  const summary = results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.html).join(', ')})`,
  );

  expect(summary).toEqual([]);
}
