import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { manifestJson, sha256Hex, zipStore } from './zip-store.js';

/** A 30-line STORE reader: walks the central directory and checks every local entry's CRC. */
function readStoreZip(zip: Buffer): Map<string, Buffer> {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('no end of central directory');
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('bad central header');
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    if (zip.readUInt32LE(offset) !== 0x04034b50) throw new Error('bad local header');
    if (zip.readUInt16LE(offset + 8) !== 0) throw new Error('not STORE');
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const data = zip.subarray(start, start + size);
    if (crc32(data) >>> 0 !== crc || zip.readUInt32LE(offset + 14) !== crc) {
      throw new Error(`crc mismatch for ${name}`);
    }
    files.set(name, Buffer.from(data));
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return files;
}

describe('zip-store (52-11)', () => {
  it('writes two files whose central directory and CRCs verify', () => {
    const a = Buffer.from('\uFEFFInvoice Number,Customer\r\nINV-1,أكمي\r\n', 'utf8');
    const b = Buffer.from('hello');
    const zip = zipStore(
      [
        { name: 'a.csv', data: a },
        { name: 'README-ar.txt', data: b },
      ],
      new Date('2026-11-02T10:20:30Z'),
    );
    const files = readStoreZip(zip);
    expect([...files.keys()]).toEqual(['a.csv', 'README-ar.txt']);
    expect(files.get('a.csv')!.equals(a)).toBe(true);
    expect(files.get('README-ar.txt')!.toString()).toBe('hello');
  });

  it('the manifest carries the SHA-256 of every file', () => {
    const data = Buffer.from('x,y\r\n');
    const manifest = JSON.parse(manifestJson([{ name: 'f.csv', data }])) as {
      files: { name: string; sha256: string; bytes: number }[];
    };
    expect(manifest.files).toEqual([
      { name: 'f.csv', bytes: 5, sha256: createHash('sha256').update(data).digest('hex') },
    ]);
    expect(sha256Hex('abc')).toHaveLength(64);
  });
});
