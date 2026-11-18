import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SWITCH_CSS = readFileSync(
  join(HERE, '../src/components/website/language-switch.css'),
  'utf8',
);

describe('SMALLFIX 5 the language switch is easy to tap', () => {
  it('gives every language button a 24 px minimum height, on every page', () => {
    expect(SWITCH_CSS).toMatch(/\.tm-web-lang__option \{\s*min-block-size: var\(--s6\);/);
  });
});
