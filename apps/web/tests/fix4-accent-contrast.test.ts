import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TMANAGE_LIME,
  accentOnInk,
  accentStylesheet,
  contrastRatio,
  textOnAccent,
} from '../src/lib/brand-accent';

/**
 * FIX4 item 5. With a dark brand colour the "+" of New work vanished: the glyph was drawn in the
 * accent itself on an ink disc. Every accent-coloured foreground now reads the auto-contrast
 * tokens (`--tm-on-lime` on the accent, `--tm-accent-on-ink` on the dark surfaces).
 */

const INK_800 = '#232521';
const INK_ABSOLUTE = '#090a09';
const BRANDS = ['#0b3d91', '#1e1b4b', '#7c3aed', '#e11d48', '#10b981', '#000000', '#ffcc00'];

describe('FIX4 item 5: the accent on dark surfaces', () => {
  it('keeps the lime as it is', () => {
    expect(accentOnInk(TMANAGE_LIME)).toBe(TMANAGE_LIME);
  });

  it('lightens a dark brand colour until it reads on ink (4.5:1)', () => {
    for (const brand of BRANDS) {
      const glyph = accentOnInk(brand);
      expect(contrastRatio(glyph, INK_800)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(glyph, INK_ABSOLUTE)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(textOnAccent(brand), brand)).toBeGreaterThanOrEqual(4.5);
    }
    expect(accentOnInk('#0b3d91')).not.toBe('#0b3d91');
  });

  it('sets the dark-surface tokens in the brand stylesheet', () => {
    const css = accentStylesheet('#0b3d91') ?? '';
    expect(css).toContain(`--tm-accent-on-ink:${accentOnInk('#0b3d91')}`);
    expect(css).toContain('--tm-accent-on-ink-deep:');
  });
});

const ROOTS = [join(__dirname, '../src'), join(__dirname, '../../../packages/ui/src')];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(css|tsx)$/u.test(name) && !name.includes('.test.')) out.push(path);
  }
  return out;
}

describe('FIX4 item 5: no accent foreground bypasses the auto-contrast colour', () => {
  it('draws no text, fill or stroke straight in --lime-500/600', () => {
    const direct =
      /(?<![-\w])(color|fill|stroke|caret-color|-webkit-text-fill-color|text-decoration-color)\s*:\s*var\(--lime-(500|600)\)/u;
    const offenders = ROOTS.flatMap((root) =>
      sources(root).flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => direct.test(line))
          .map(({ index }) => `${relative(root, file)}:${index + 1}`),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('puts the auto-contrast text on every accent fill that names a text colour', () => {
    const rule = /([^{}]+)\{([^{}]*)\}/gu;
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of sources(root)) {
        const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
        for (const match of text.matchAll(rule)) {
          const body = match[2] ?? '';
          const fill = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/u.exec(body)?.[1] ?? '';
          if (!/var\(--lime-(500|600)\)/u.test(fill) || /color-mix|gradient/u.test(fill)) continue;
          const ink = /(?:^|;)\s*color\s*:\s*([^;]+)/u.exec(body)?.[1];
          if (ink !== undefined && !/on-lime/u.test(ink)) {
            offenders.push(`${relative(root, file)}: ${(match[1] ?? '').trim().slice(-60)}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
