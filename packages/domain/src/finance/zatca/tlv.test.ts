import { describe, expect, it } from 'vitest';
import { sha256Hex, utf8 } from './bytes.js';
import { decodeTlv, phase1Qr } from './tlv.js';

/** 52-12 (R21-c) — ZATCA Phase-1 QR (TLV tags 1–5, base64). */
describe('phase1Qr', () => {
  const sample = {
    sellerName: 'Bobs Records',
    vatNumber: '310122393500003',
    timestamp: new Date('2022-04-25T15:30:00.000Z'),
    totalWithVat: '1000.00',
    vatAmount: '150.00',
  };

  it('matches the ZATCA sample and decodes tag by tag', () => {
    const payload = phase1Qr(sample);
    expect(payload).toBe(
      'AQxCb2JzIFJlY29yZHMCDzMxMDEyMjM5MzUwMDAwMwMUMjAyMi0wNC0yNVQxNTozMDowMFoEBzEwMDAuMDAFBjE1MC4wMA==',
    );
    expect(decodeTlv(payload)).toEqual([
      { tag: 1, length: 12, value: 'Bobs Records' },
      { tag: 2, length: 15, value: '310122393500003' },
      { tag: 3, length: 20, value: '2022-04-25T15:30:00Z' },
      { tag: 4, length: 7, value: '1000.00' },
      { tag: 5, length: 6, value: '150.00' },
    ]);
  });

  it('counts UTF-8 bytes for an Arabic seller name and cuts an over-long one at a boundary', () => {
    const arabic = decodeTlv(phase1Qr({ ...sample, sellerName: 'شركة' }))[0];
    expect(arabic).toEqual({ tag: 1, length: 8, value: 'شركة' });
    const long = decodeTlv(phase1Qr({ ...sample, sellerName: 'ش'.repeat(200) }))[0];
    expect(long?.length).toBe(254);
    expect(long?.value).toBe('ش'.repeat(127));
  });

  it('refuses an amount without two decimal places', () => {
    expect(() => phase1Qr({ ...sample, vatAmount: '150' })).toThrow(RangeError);
  });
});

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 vectors', () => {
    expect(sha256Hex(utf8(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(utf8('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
