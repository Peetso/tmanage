import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const GLOBALS_CSS = readFileSync(join(HERE, '../src/app/globals.css'), 'utf8');

describe('C11 the nav rail mirrors in Arabic', () => {
  it('leaves the rail as the first grid column, with no RTL column swap', () => {
    expect(GLOBALS_CSS).toMatch(
      /\.tm-app__frame\s*\{[^}]*grid-template-columns:\s*var\(--rail\) minmax\(0, 1fr\);/,
    );
    expect(GLOBALS_CSS).not.toMatch(/\[dir='rtl'\]\s*\.tm-(app__frame|rail|app__body)\s*\{/);
  });
});
