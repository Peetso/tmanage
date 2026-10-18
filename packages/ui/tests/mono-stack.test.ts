import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCustomProperties, readPackageTokensCss } from './design-source.js';
import { typeFamily } from '../src/tokens/tokens.js';

const baseCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/styles/base.css'),
  'utf8',
);

function families(value: string | undefined): string[] {
  return (value ?? '').split(',').map((family) => family.trim().replace(/^['"]|['"]$/g, ''));
}

/**
 * base.css re-states `--font-mono` with platform fallbacks (tokens.css stays the export's value).
 * The fallback may only add faces after the token's own: Geist Mono first, a generic last.
 */
describe('the packaged mono stack', () => {
  const token = parseCustomProperties(readPackageTokensCss()).get(':root')?.get('--font-mono');
  const declared = /--font-mono:\s*([^;]+);/.exec(baseCss)?.[1];

  it('falls back to Geist Mono first, the same face the token names', () => {
    const stack = families(declared);
    expect(stack[0]).toBe(typeFamily.mono);
    expect(stack[0]?.toLowerCase().replace(/\s+/g, '')).toBe(
      families(token)[0]?.toLowerCase().replace(/\s+/g, ''),
    );
  });

  it('names a platform UI mono before the generic, and ends on the generic', () => {
    const stack = families(declared);
    expect(stack).toContain('ui-monospace');
    expect(stack.indexOf('ui-monospace')).toBeLessThan(stack.indexOf('monospace'));
    expect(stack.at(-1)).toBe('monospace');
  });
});
