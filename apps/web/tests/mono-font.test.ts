import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(HERE, '../src/app');
const GLOBALS_CSS = readFileSync(join(APP_DIR, 'globals.css'), 'utf8');
const FACES = [...GLOBALS_CSS.matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => m[0]);

describe('Geist Mono is self-hosted', () => {
  it('declares local woff2 faces only, each file present with its licence', () => {
    const mono = FACES.filter((face) => face.includes("'Geist Mono'"));
    expect(mono).toHaveLength(2);
    for (const face of mono) {
      const url = /url\('([^']+)'\)/.exec(face)?.[1] ?? '';
      expect(url).toMatch(/^\.\.\/fonts\/GeistMono-[\w-]+\.woff2$/);
      expect(readFileSync(join(APP_DIR, url)).subarray(0, 4).toString('latin1')).toBe('wOF2');
      expect(face).toMatch(/unicode-range:/);
    }
    expect(existsSync(join(APP_DIR, '../fonts/GeistMono-OFL.txt'))).toBe(true);
    expect(GLOBALS_CSS).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });

  it('puts Geist Mono first in the mono token stack', () => {
    expect(GLOBALS_CSS).toMatch(/--font-mono:\s*'Geist Mono',/);
  });
});
