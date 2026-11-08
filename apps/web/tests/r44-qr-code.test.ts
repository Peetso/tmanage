import { describe, expect, it } from 'vitest';
import { encodeQr, formatBits, qrSvgPath, reedSolomon } from '../src/lib/qr/qr-code';

/**
 * 52-20 QR encoder. Known answers from ISO/IEC 18004 (Annex I: the version 1-M Reed–Solomon
 * example; level M / mask 0 format word), then the structure a scanner locks on to: finders,
 * timing, the dark module, and a format word that names one of the eight masks.
 */

/** The mask named by the format word read out of the matrix, or `undefined` when none matches. */
function formatMask(text: string): number | undefined {
  const { modules } = encodeQr(text);
  let word = 0;
  // First copy of the format word, bits 0..14 as drawn by the encoder.
  const cells: [number, number][] = [];
  for (let i = 0; i <= 5; i++) cells.push([8, i]);
  cells.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) cells.push([14 - i, 8]);
  cells.forEach(([x, y], i) => {
    if (modules[y]![x]) word |= 1 << i;
  });
  return [0, 1, 2, 3, 4, 5, 6, 7].find((m) => formatBits(m) === word);
}

describe('52-20 · QR code encoder', () => {
  it('computes the ISO version 1-M Reed–Solomon codewords', () => {
    const data = [
      0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec,
      0x11,
    ];
    expect(reedSolomon(data, 10)).toEqual([
      0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55,
    ]);
    expect(formatBits(0)).toBe(0b101010000010010);
  });

  it('draws the three finder patterns, timing lines and a readable format word', () => {
    const { modules, size, version } = encodeQr('https://tmanage.peetrix.com/f/vpfzzphuz9');
    expect(version).toBe(3);
    expect(size).toBe(29);
    for (const [x, y] of [
      [0, 0],
      [size - 7, 0],
      [0, size - 7],
    ] as const) {
      expect(modules[y]![x]).toBe(true);
      expect(modules[y + 1]![x + 1]).toBe(false);
      expect(modules[y + 3]![x + 3]).toBe(true);
    }
    expect(modules[6]!.slice(8, size - 8)).toEqual(
      Array.from({ length: size - 16 }, (_, i) => (i + 8) % 2 === 0),
    );
    expect(modules[size - 8]![8]).toBe(true); // the dark module
    expect(formatMask('https://tmanage.peetrix.com/f/vpfzzphuz9')).toBeTypeOf('number');
  });

  it('grows the version with the text and refuses text past version 10', () => {
    expect(encodeQr('a'.repeat(120)).version).toBeGreaterThan(5);
    expect(() => encodeQr('a'.repeat(300))).toThrow(RangeError);
  });

  it('renders one path segment per dark module inside a quiet zone', () => {
    const matrix = encodeQr('x');
    const dark = matrix.modules.flat().filter(Boolean).length;
    const path = qrSvgPath(matrix);
    expect(path.split('z').length - 1).toBe(dark);
    expect(path.startsWith('M4 4')).toBe(true);
  });
});
