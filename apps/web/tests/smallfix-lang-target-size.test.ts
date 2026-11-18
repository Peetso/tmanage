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

describe('VR2 fixes 5 and 7 the phone language switch and footer', () => {
  const WEBSITE_CSS = readFileSync(join(HERE, '../src/components/website/website.css'), 'utf8');
  const SIGN_IN_CSS = readFileSync(join(HERE, '../src/app/sign-in/sign-in-lang.css'), 'utf8');

  it('swaps the dotted row for the language menu below tablet width', () => {
    expect(SWITCH_CSS).toMatch(/\.tm-web-lang__menu \{\s*display: none;/);
    expect(SWITCH_CSS).toMatch(
      /@media \(max-width: 767px\) \{\s*\.tm-web-lang__row \{\s*display: none;\s*\}\s*\.tm-web-lang__menu \{\s*display: block;/,
    );
  });

  it('marks the chosen language in full ink, once, for every page', () => {
    expect(SWITCH_CSS).toMatch(
      /\.tm-web-lang__option\[aria-pressed='true'\] \{\s*color: var\(--ink-950\);/,
    );
    expect(SIGN_IN_CSS).not.toContain("aria-pressed='true'");
  });

  it('draws one rule between the last footer fold and the language row on a phone', () => {
    expect(WEBSITE_CSS).toMatch(
      /\.tm-web-footer__accordions \.tm-web-accordion:last-child \{\s*border-block-end: 0;/,
    );
  });
});
