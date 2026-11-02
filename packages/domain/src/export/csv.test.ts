import { describe, expect, it } from 'vitest';
import { escapeCsvCell, toCsv } from './csv.js';

describe('escapeCsvCell — the injection corpus', () => {
  it.each([
    ['=SUM(A1)', "'=SUM(A1)"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@cmd', "'@cmd"],
    ['\tx', "'\tx"],
    ['\rx', '"\'\rx"'],
    ['＝cmd', "'＝cmd"],
    ['=cmd,1', '"\'=cmd,1"'],
    ['a"b', '"a""b"'],
    ['line\nbreak', '"line\nbreak"'],
    ['مرحبا بالعالم', 'مرحبا بالعالم'],
    [42, '42'],
    [null, ''],
    [undefined, ''],
  ])('%j -> %j', (input, expected) => {
    expect(escapeCsvCell(input)).toBe(expected);
  });
});

describe('toCsv', () => {
  it('writes CRLF records, header first, and a BOM only when asked', () => {
    expect(toCsv([['=x', 1]], ['a', 'b'])).toBe("a,b\r\n'=x,1\r\n");
    expect(toCsv([['a'], ['b']])).toBe('a\r\nb\r\n');
    expect(toCsv([['ع']], null, { bom: true })).toBe('﻿ع\r\n');
  });
});
