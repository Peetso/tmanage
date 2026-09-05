import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { ScanError, ScannerUnavailableError } from './malware-scanner.js';
import type { MalwareScanner, ScanInput, ScanResult } from './malware-scanner.js';

/**
 * ClamAV over TCP — clamd's `INSTREAM` command, framed by hand on a `node:net` socket.
 * No library: the protocol is four lines long and a dependency would be a second thing
 * to audit for the sake of not writing them.
 *
 * ## The wire
 *
 * `zINSTREAM\0`, then the object as chunks of `<4-byte big-endian length><bytes>`, then a
 * zero-length chunk; clamd answers one line, NUL-terminated because the command was sent
 * with the `z` prefix: `stream: OK`, `stream: <detection> FOUND`, or `<text> ERROR`. The
 * probe is `zPING\0` → `PONG`. Chunks are re-framed at {@link FRAME_BYTES} regardless of
 * how the source stream delivered them.
 *
 * ## What each reply becomes
 *
 * `OK` is `clean`; `FOUND` is `infected` with the detection name for the operator's
 * stderr line and nowhere else; **anything else is an error, never a verdict** — an
 * `ERROR` line (`INSTREAM size limit exceeded` when the object is over clamd's
 * `StreamMaxLength`), an empty reply, a reply this driver does not recognise. Two of
 * clamd's own settings decide what `OK` means and are the deployment's to set, recorded
 * in `.env.example`: `StreamMaxLength` must be at least `UPLOAD_MAX_BYTES` or a legal
 * upload is refused as an error every pass, and `AlertExceedsMax yes` makes an archive
 * beyond clamd's scan limits a `FOUND` rather than a silent `OK` (`26-THREAT-MODELS` §79,
 * archive bombs). The driver cannot see those settings and does not pretend to.
 *
 * ## Two clocks, two failures
 *
 * A connection that is refused, unresolvable, or not established within
 * {@link CONNECT_TIMEOUT_MS} is {@link ScannerUnavailableError}: the engine is not there,
 * and the pass stops before it claims a row. Everything after the connection — a scan
 * that does not finish within `timeoutMs` (`MALWARE_SCAN_TIMEOUT_MS`, the whole object),
 * a socket reset mid-stream, a reply that is not a verdict — is {@link ScanError} for that
 * one object: its row keeps its claim and is retried after the bound. The default thirty
 * seconds is enough for a small file across a LAN and may not be for a hundred-megabyte
 * one; the variable exists so an operator can say so. The clock bounds the engine, not
 * the source: a store stream that stalls stalls the pass, and that is the store's fault
 * to report, not a verdict to invent.
 */

export interface ClamavScannerOptions {
  readonly host: string;
  readonly port: number;
  /** One object's whole scan: connect, stream, reply. */
  readonly timeoutMs: number;
  /** Injectable for the suite: the socket factory. `node:net`'s `connect` otherwise. */
  readonly connect?: ((host: string, port: number) => Socket) | undefined;
}

export const CONNECT_TIMEOUT_MS = 5_000;
/** clamd accepts any chunk size up to its stream limit; 64 KiB keeps frames small and many. */
export const FRAME_BYTES = 64 * 1024;

const ZERO_CHUNK = Buffer.alloc(4, 0);

function frame(bytes: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([header, bytes]);
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown';
}

export class ClamavScanner implements MalwareScanner {
  readonly name = 'clamav' as const;
  readonly kind = 'engine' as const;
  private readonly dial: (host: string, port: number) => Socket;

  constructor(private readonly options: ClamavScannerOptions) {
    this.dial = options.connect ?? ((host, port) => connect({ host, port }));
  }

  async probe(): Promise<void> {
    const socket = await this.open();
    try {
      socket.write('zPING\0');
      const reply = await readReply(socket, this.options.timeoutMs);
      if (reply !== 'PONG') throw new ScannerUnavailableError(`unexpected ping reply`);
    } catch (error) {
      if (error instanceof ScannerUnavailableError) throw error;
      throw new ScannerUnavailableError(
        error instanceof ScanError ? error.failure : errorCode(error),
      );
    } finally {
      socket.destroy();
    }
  }

  async scan(input: ScanInput): Promise<ScanResult> {
    const socket = await this.open();
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      socket.destroy(new ScanError('timeout'));
    }, this.options.timeoutMs);
    try {
      const replied = readReply(socket, this.options.timeoutMs);
      // A reply that arrives before the stream is done (an ERROR on a size limit) must
      // not be an unhandled rejection while the write loop is still going.
      replied.catch(() => undefined);
      socket.write('zINSTREAM\0');
      try {
        for await (const piece of input.stream) {
          const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as string);
          for (let offset = 0; offset < chunk.length; offset += FRAME_BYTES) {
            if (socket.destroyed) break;
            await write(socket, frame(chunk.subarray(offset, offset + FRAME_BYTES)));
          }
        }
      } catch (error) {
        if (timedOut) throw new ScanError('timeout');
        if (error instanceof ScanError) throw error;
        throw new ScanError('stream_error');
      }
      if (!socket.destroyed) await write(socket, ZERO_CHUNK);
      const reply = await replied;
      if (reply === 'stream: OK') return { verdict: 'clean' };
      const found = /^stream: (.+) FOUND$/.exec(reply);
      if (found?.[1]) return { verdict: 'infected', detection: found[1] };
      throw new ScanError(reply.endsWith('ERROR') ? 'engine_error' : 'protocol_error');
    } finally {
      clearTimeout(deadline);
      socket.destroy();
      destroyQuietly(input.stream);
    }
  }

  /** A connected socket, or `ScannerUnavailableError`. */
  private open(): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      let socket: Socket;
      try {
        socket = this.dial(this.options.host, this.options.port);
      } catch (error) {
        reject(new ScannerUnavailableError(errorCode(error)));
        return;
      }
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new ScannerUnavailableError('connect timeout'));
      }, CONNECT_TIMEOUT_MS);
      const failed = (error: unknown) => {
        clearTimeout(timer);
        socket.destroy();
        reject(new ScannerUnavailableError(errorCode(error)));
      };
      socket.once('error', failed);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.off('error', failed);
        resolve(socket);
      });
    });
  }
}

/**
 * One NUL-terminated line from clamd. A connection that errors or closes before the line
 * — a reset mid-object, a daemon that hangs up after the zero chunk — is `stream_error`
 * whenever it happened: the engine did not answer. `protocol_error` is reserved for a
 * line that is not a verdict.
 */
function readReply(socket: Socket, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => settle(() => reject(new ScanError('timeout'))), timeoutMs);
    socket.on('data', (data: Buffer) => {
      chunks.push(data);
      const all = Buffer.concat(chunks);
      const end = all.indexOf(0);
      if (end !== -1) settle(() => resolve(all.subarray(0, end).toString('utf8').trim()));
    });
    socket.once('error', (error: unknown) =>
      settle(() => reject(error instanceof ScanError ? error : new ScanError('stream_error'))),
    );
    socket.once('close', () => settle(() => reject(new ScanError('stream_error'))));
  });
}

function write(socket: Socket, bytes: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (socket.destroyed) {
      reject(new ScanError('stream_error'));
      return;
    }
    socket.write(bytes, (error) => (error ? reject(new ScanError('stream_error')) : resolve()));
  });
}

function destroyQuietly(stream: NodeJS.ReadableStream): void {
  const candidate = stream as { destroy?: () => void; destroyed?: boolean };
  if (typeof candidate.destroy === 'function' && !candidate.destroyed) candidate.destroy();
}
