import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractorFor, type ExtractedText, type TextLimits } from './file-text-extractors.js';

/**
 * 62-A0 fallback (1), decided by the manager on 2026-11-21 — big files are read in a short-lived
 * child process, so the one live process keeps answering web requests while a 20 MB PDF is
 * parsed (measured: 326 ms stall in-process, 20 ms with a child; PLAN-62-P0-RESULTS.md).
 *
 * - **Which files:** over {@link CHILD_ABOVE_BYTES}. Every seed file of the benchmark (24 KB at
 *   most, ≤ 82 ms stall) stays in-process; the stall grew to 326 ms at 20 MB, about 16 ms a MB on
 *   the laptop, so 2 MB keeps a shared-hosting CPU three times slower under the 200 ms bar.
 * - **Caps (ST-1):** the child's V8 heap is capped (`--max-old-space-size`, {@link CHILD_HEAP_MB});
 *   it is killed at the text limits' own timeout plus a grace for its start. An overrun is a plain
 *   outcome, `failed` with a reason the text row keeps: `extract_timeout`,
 *   `extract_out_of_memory`, `extract_crashed`.
 * - **At most one alive:** a second call waits for the first child to end.
 * - **Dies with its parent (RT-6):** the child is forked (an IPC channel) with the app server's
 *   parent watchdog preloaded (`apps/server/parent-watchdog.mjs`, lane U R2) and
 *   `TMANAGE_PARENT_PID` set; when the parent is SIGKILLed the channel closes or the pid goes,
 *   and the child exits. The child entry also exits on `disconnect` itself, for a run with no
 *   watchdog file (local dev, unit tests).
 */

/** Files over this many bytes are read in the child. */
export const CHILD_ABOVE_BYTES = 2 * 1024 * 1024;
/** The child's V8 heap cap, in MB (the 20 MB PDF peaked at 175 MB RSS). */
export const CHILD_HEAP_MB = 384;
/** Time for the child to start (Node + the extractor modules) before its own deadline runs. */
export const CHILD_START_GRACE_MS = 10_000;

export interface IsolatedTextExtractor {
  /** Whether a file of this size goes to the child. */
  takes(sizeBytes: number): boolean;
  extract(bytes: Uint8Array, mimeType: string, limits: TextLimits): Promise<ExtractedText>;
}

export interface ChildTextExtractorOptions {
  /** The child entry module (compiled `file-text-child.js` beside this file by default). */
  readonly entry: string;
  /** `parent-watchdog.mjs` to preload, or `null` when none is found. */
  readonly watchdog: string | null;
  readonly heapMb: number;
  readonly aboveBytes: number;
  /** The hard kill, after the extractor's own timeout. */
  readonly killAfterMs: (limits: TextLimits) => number;
  readonly fork: (entry: string, args: readonly string[], options: ForkOptions) => ChildProcess;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The watchdog the app server ships beside `server.mjs` (deploy/hostinger/build.mjs SERVER_FILES):
 * `TMANAGE_PARENT_WATCHDOG` when set, else `parent-watchdog.mjs` next to the main script, else in
 * the working directory (LiteSpeed's lsnode loader can be the main script; the app root is the
 * working directory there).
 */
export function findParentWatchdog(
  env: NodeJS.ProcessEnv = process.env,
  main: string | undefined = process.argv[1],
  exists: (path: string) => boolean = existsSync,
  cwd: string = process.cwd(),
): string | null {
  const named = env['TMANAGE_PARENT_WATCHDOG'];
  if (typeof named === 'string' && named !== '' && exists(named)) return named;
  const candidates = [
    ...(main === undefined || main === '' ? [] : [resolve(dirname(main), 'parent-watchdog.mjs')]),
    resolve(cwd, 'parent-watchdog.mjs'),
  ];
  return candidates.find((path) => exists(path)) ?? null;
}

const failed = (code: string, mimeType: string): ExtractedText => ({
  status: 'failed',
  code,
  extractor: extractorFor(mimeType)?.name ?? null,
});

const OUT_OF_MEMORY = /heap limit|out of memory|allocation failed/i;

export class ChildTextExtractor implements IsolatedTextExtractor {
  private readonly options: ChildTextExtractorOptions;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: Partial<ChildTextExtractorOptions> = {}) {
    this.options = {
      entry: options.entry ?? resolve(HERE, 'file-text-child.js'),
      watchdog: options.watchdog === undefined ? findParentWatchdog() : options.watchdog,
      heapMb: options.heapMb ?? CHILD_HEAP_MB,
      aboveBytes: options.aboveBytes ?? CHILD_ABOVE_BYTES,
      killAfterMs: options.killAfterMs ?? ((limits) => limits.timeoutMs + CHILD_START_GRACE_MS),
      fork: options.fork ?? ((entry, args, forkOptions) => fork(entry, [...args], forkOptions)),
    };
  }

  /** Whether the child can run here (its entry is built); without it, files stay in-process. */
  available(): boolean {
    return existsSync(this.options.entry);
  }

  takes(sizeBytes: number): boolean {
    return sizeBytes > this.options.aboveBytes;
  }

  extract(bytes: Uint8Array, mimeType: string, limits: TextLimits): Promise<ExtractedText> {
    // At most one child alive: each call starts after the previous one ended.
    const run = this.queue.then(() => this.once(bytes, mimeType, limits));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private once(bytes: Uint8Array, mimeType: string, limits: TextLimits): Promise<ExtractedText> {
    const { watchdog, heapMb } = this.options;
    const child = this.options.fork(this.options.entry, [], {
      execArgv: [
        `--max-old-space-size=${String(heapMb)}`,
        ...(watchdog === null ? [] : ['--import', pathToFileURL(watchdog).href]),
      ],
      env: { ...process.env, TMANAGE_PARENT_PID: String(process.pid) },
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (piece: string) => {
      if (stderr.length < 4_096) stderr += piece;
    });
    return new Promise<ExtractedText>((settle) => {
      let done = false;
      const finish = (outcome: ExtractedText) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        settle(outcome);
      };
      const timer = setTimeout(
        () => finish(failed('extract_timeout', mimeType)),
        this.options.killAfterMs(limits),
      );
      child.on('message', (message) => {
        const outcome = (message as { outcome?: ExtractedText } | null)?.outcome;
        finish(outcome ?? failed('extract_crashed', mimeType));
      });
      child.on('error', () => finish(failed('extract_crashed', mimeType)));
      child.on('exit', () => {
        // Read stderr to its end before deciding why it died.
        setImmediate(() =>
          finish(
            failed(
              OUT_OF_MEMORY.test(stderr) ? 'extract_out_of_memory' : 'extract_crashed',
              mimeType,
            ),
          ),
        );
      });
      child.send({ bytes, mimeType, limits });
    });
  }
}

/**
 * The child extractor of the running app, or `null` when its entry is not built (running from
 * TypeScript sources): then every file is read in-process, as before 62-A0, and this says so.
 */
export function isolatedTextExtractor(
  log: (line: string) => void = (line) => console.warn(line),
): ChildTextExtractor | null {
  const extractor = new ChildTextExtractor();
  if (extractor.available()) return extractor;
  log('[file-text] child extractor not built; big files are read in-process');
  return null;
}
