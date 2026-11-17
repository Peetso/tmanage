import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const IDENTITY_CSS = readFileSync(join(HERE, '../src/styles/screens/identity.css'), 'utf8');

describe('sign-up and sign-in footer links are easy to tap', () => {
  it('gives every identity link a 24 px tap area without moving the text, in both directions', () => {
    expect(IDENTITY_CSS).toMatch(/\.tm-id-link \{[^}]*position: relative;[^}]*\}/u);
    expect(IDENTITY_CSS).toMatch(
      /\.tm-id-link::after \{[^}]*position: absolute;[^}]*inset-inline: 0;[^}]*min-block-size: var\(--s6\);[^}]*\}/u,
    );
  });
});
