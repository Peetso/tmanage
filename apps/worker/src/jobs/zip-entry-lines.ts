/**
 * SEC-ALERTS item 7. The text lines of one entry of a ZIP archive, read as a stream: the IP2Proxy
 * LITE download is a ZIP holding a ~150 MB CSV, which must not be held in memory.
 *
 * Reads local file headers in order (APPNOTE.TXT §4.3.7: signature 0x04034b50, then 26 bytes of
 * fields, the name and the extra field). An entry whose name does not match is skipped by its
 * compressed size; the matching entry is inflated (method 8, raw DEFLATE) or passed through
 * (method 0) and split into lines. An entry that sets bit 3 (sizes in a trailing data descriptor)
 * can only be read when it is the one wanted, because its end is known only by inflating it.
 * Pure Node (`node:zlib`, `node:readline`): no archive library is added for one file.
 */
import { createInterface } from 'node:readline';
import { PassThrough, type Readable } from 'node:stream';
import { createInflateRaw } from 'node:zlib';

const LOCAL_HEADER = 0x04034b50;
const HEADER_BYTES = 30;

class ByteReader {
  private buffered = Buffer.alloc(0);
  private readonly iterator: AsyncIterator<Buffer>;
  private done = false;

  constructor(input: Readable) {
    this.iterator = (input as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  }

  /** At least `n` bytes buffered, or false at the end of the input. */
  async fill(n: number): Promise<boolean> {
    while (this.buffered.length < n && !this.done) {
      const next = await this.iterator.next();
      if (next.done === true) this.done = true;
      else this.buffered = Buffer.concat([this.buffered, Buffer.from(next.value)]);
    }
    return this.buffered.length >= n;
  }

  take(n: number): Buffer {
    const head = this.buffered.subarray(0, n);
    this.buffered = this.buffered.subarray(n);
    return head;
  }

  /** Every remaining byte, chunk by chunk, up to `limit` bytes when it is given. */
  async *rest(limit?: number): AsyncGenerator<Buffer> {
    let left = limit ?? Number.POSITIVE_INFINITY;
    while (left > 0) {
      if (this.buffered.length === 0 && !(await this.fill(1))) return;
      const chunk = this.take(Math.min(left, this.buffered.length));
      left -= chunk.length;
      yield chunk;
    }
  }

  async skip(n: number): Promise<void> {
    for await (const chunk of this.rest(n)) void chunk;
  }
}

export async function* zipEntryLines(
  input: Readable,
  wanted: (name: string) => boolean,
): AsyncGenerator<string> {
  const reader = new ByteReader(input);
  for (;;) {
    if (!(await reader.fill(HEADER_BYTES))) throw new Error('zip entry not found');
    const header = reader.take(HEADER_BYTES);
    if (header.readUInt32LE(0) !== LOCAL_HEADER) throw new Error('zip entry not found');
    const flags = header.readUInt16LE(6);
    const method = header.readUInt16LE(8);
    const compressedSize = header.readUInt32LE(18);
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    await reader.fill(nameLength + extraLength);
    const name = reader.take(nameLength).toString('utf8');
    reader.take(extraLength);
    const sizeKnown = (flags & 0x08) === 0;
    if (!wanted(name)) {
      if (!sizeKnown) throw new Error('zip entry not found');
      await reader.skip(compressedSize);
      continue;
    }
    if (method !== 0 && method !== 8) throw new Error('unsupported zip compression');
    const output = method === 8 ? createInflateRaw() : new PassThrough();
    const feed = async (): Promise<void> => {
      try {
        for await (const chunk of reader.rest(sizeKnown ? compressedSize : undefined)) {
          if (output.writableEnded || output.destroyed) break;
          if (!output.write(chunk)) {
            // `close` too: a destroyed stream never drains, and the feed must not wait forever.
            await new Promise<void>((resolve) => {
              const done = (): void => {
                output.off('drain', done);
                output.off('close', done);
                resolve();
              };
              output.on('drain', done);
              output.on('close', done);
            });
          }
        }
        if (!output.writableEnded) output.end();
      } catch (error) {
        output.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    };
    void feed();
    yield* createInterface({ input: output, crlfDelay: Infinity });
    return;
  }
}
