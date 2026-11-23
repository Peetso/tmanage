import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const GLOBALS_CSS = readFileSync(join(HERE, '../src/app/globals.css'), 'utf8');

describe('C11 the nav rail mirrors in Arabic', () => {
  it('leaves the rail as the first grid column, with no RTL column swap', () => {
    expect(GLOBALS_CSS).toMatch(
      /\.tm-app__frame\s*\{[^}]*grid-template-columns:\s*var\(--app-rail\) minmax\(0, 1fr\);/,
    );
    expect(GLOBALS_CSS).not.toMatch(/\[dir='rtl'\]\s*\.tm-(app__frame|rail|app__body)\s*\{/);
  });

  it('gives the canvas the same gutter on the rail side in both directions (owner 2026-11-23)', () => {
    // 7ce92a65 replaced the Arabic-only rule with one logical gutter; Density v2 (ADR-0016) makes
    // it the `--page-gutter` token (32 / 24 / 16). The layout check measures it in a browser.
    expect(GLOBALS_CSS).toMatch(/\.tm-app__body\s*\{[^}]*padding-inline:\s*var\(--page-gutter\);/);
  });
});
