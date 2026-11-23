import { describe, expect, it } from 'vitest';
import { inputJsonSchema, validExamples } from './action-errors.js';
import { allDetailsList } from './tool-catalog.js';

/**
 * Fix lane A, 2026-11-23 (live test §8 fix 2). `tmanage_describe_action` now hands the AI each
 * op's examples next to its input schema, so an example that fails its own schema would teach the
 * AI a call that is refused. Every example of every op must parse; every op's schema must convert
 * to a JSON Schema object. (Whether an example also passes the live route is the route contract
 * test of fix 3, another lane.)
 */
describe('registry examples and schemas', () => {
  it('every example of every op parses against that op’s own input schema', () => {
    const failing = allDetailsList.flatMap((detail) =>
      detail.examples
        .map((example, index) => ({ example, index }))
        .filter(({ example }) => !detail.input.safeParse(example.args).success)
        .map(({ index }) => `${detail.id}#${index}`),
    );
    expect(failing).toEqual([]);
  });

  it('every op has at least one example that describe returns', () => {
    expect(allDetailsList.filter((d) => validExamples(d).length === 0).map((d) => d.id)).toEqual(
      [],
    );
  });

  it('every op input converts to a JSON Schema object', () => {
    const notObjects = allDetailsList
      .filter((d) => inputJsonSchema(d.input)['type'] !== 'object')
      .map((d) => d.id);
    expect(notObjects).toEqual([]);
  });
});
