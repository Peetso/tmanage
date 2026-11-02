import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';

/**
 * 52-11 — a STORE-only (uncompressed) zip writer, so the accounting export needs no new dependency.
 * Local file headers + data, the central directory, the end-of-central-directory record; CRC-32 from
 * `node:zlib` (Node ≥ 22.12). Names are flagged UTF-8 (general-purpose bit 11). No zip64: one
 * export is bounded far below 4 GiB (≤ 5,000 invoices). The DOS timestamp is fixed at the export
 * instant so the same input and instant give the same bytes.
 */

export interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

const UTF8_FLAG = 0x0800;
const VERSION = 20;
const MAX_ZIP32 = 0xffff_ffff;

function dosDateTime(at: Date): { readonly time: number; readonly date: number } {
  const year = Math.max(1980, at.getUTCFullYear());
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

/** Write a STORE zip of the entries, in order. */
export function zipStore(entries: readonly ZipEntry[], at: Date = new Date()): Buffer {
  const { time, date } = dosDateTime(at);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data) >>> 0;
    const size = entry.data.byteLength;
    if (size > MAX_ZIP32 || offset > MAX_ZIP32) throw new RangeError('zip64 is not supported');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8); // method: STORE
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(VERSION, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.byteLength, 28);
    // extra length, comment length, disk number, internal and external attributes: all zero.
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.byteLength + name.byteLength + size;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export const sha256Hex = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex');

/**
 * `manifest.json` — the SHA-256 and size of every file in the export, so an accountant (or an
 * auditor) can prove a file was not changed after it left TManage.
 */
export function manifestJson(
  files: readonly ZipEntry[],
  meta: Readonly<Record<string, string | number | boolean>> = {},
): string {
  const body = {
    ...meta,
    algorithm: 'SHA-256',
    files: files.map((file) => ({
      name: file.name,
      bytes: file.data.byteLength,
      sha256: sha256Hex(file.data),
    })),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}
