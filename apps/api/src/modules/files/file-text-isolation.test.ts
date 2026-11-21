import { fork, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TEXT_LIMITS } from './file-text-extractors.js';
import {
  CHILD_ABOVE_BYTES,
  ChildTextExtractor,
  findParentWatchdog,
} from './file-text-isolation.js';

/**
 * 62-A0 fallback (1) — the child extractor's caps: a child past its time is killed and the file
 * is `failed` `extract_timeout`; a child past its heap cap dies and the file is `failed`
 * `extract_out_of_memory`; the child starts with the heap cap, the parent watchdog and the
 * parent's pid. The children are small fixtures (`test/fixtures/text-child/`), not the extractor.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../test/fixtures/text-child');
const WATCHDOG = resolve(HERE, '../../../../server/parent-watchdog.mjs');
const PDF = 'application/pdf';

function extractor(entry: string, options: { heapMb?: number; killAfterMs?: number } = {}) {
  const children: ChildProcess[] = [];
  const isolated = new ChildTextExtractor({
    entry: resolve(FIXTURES, entry),
    watchdog: WATCHDOG,
    ...(options.heapMb === undefined ? {} : { heapMb: options.heapMb }),
    killAfterMs: () => options.killAfterMs ?? 20_000,
    fork: (path, args, forkOptions) => {
      const child = fork(path, [...args], forkOptions);
      children.push(child);
      return child;
    },
  });
  return { isolated, children };
}

const gone = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

describe('the child text extractor (62-A0)', () => {
  it('kills a child that overruns its time and marks the file failed', async () => {
    const { isolated, children } = extractor('hang.mjs', { killAfterMs: 400 });
    const started = Date.now();
    const outcome = await isolated.extract(new Uint8Array(8), PDF, DEFAULT_TEXT_LIMITS);
    expect(outcome).toEqual({ status: 'failed', code: 'extract_timeout', extractor: 'pdf' });
    expect(Date.now() - started).toBeLessThan(10_000);
    await new Promise((settle) => setTimeout(settle, 300));
    expect(children).toHaveLength(1);
    expect(gone(children[0]!)).toBe(true);
  });

  it('a child past its heap cap dies, and the file is failed out of memory', async () => {
    const { isolated, children } = extractor('grow.mjs', { heapMb: 32 });
    const outcome = await isolated.extract(new Uint8Array(8), PDF, DEFAULT_TEXT_LIMITS);
    expect(outcome).toEqual({ status: 'failed', code: 'extract_out_of_memory', extractor: 'pdf' });
    expect(gone(children[0]!)).toBe(true);
  }, 30_000);

  it('starts the child with the heap cap, the parent watchdog and this pid; one at a time', async () => {
    const { isolated, children } = extractor('echo.mjs');
    const [first, second] = await Promise.all([
      isolated.extract(new Uint8Array(5), 'text/plain', DEFAULT_TEXT_LIMITS),
      isolated.extract(new Uint8Array(7), 'text/plain', DEFAULT_TEXT_LIMITS),
    ]);
    const seen = (outcome: typeof first) =>
      JSON.parse(outcome.status === 'ready' ? outcome.text : '{}') as Record<string, unknown>;
    expect(seen(first)).toEqual({
      execArgv: ['--max-old-space-size=384', '--import', pathToFileURL(WATCHDOG).href],
      parentPid: String(process.pid),
      bytes: 5,
      mimeType: 'text/plain',
    });
    expect(seen(second)['bytes']).toBe(7);
    expect(children).toHaveLength(2);
  }, 30_000);

  it('takes only files over the threshold', () => {
    const { isolated } = extractor('echo.mjs');
    expect(isolated.takes(CHILD_ABOVE_BYTES)).toBe(false);
    expect(isolated.takes(CHILD_ABOVE_BYTES + 1)).toBe(true);
  });

  it('finds the watchdog the app server ships beside its main script', () => {
    const at = (paths: string[]) => (path: string) => paths.includes(path);
    const beside = resolve('/app/parent-watchdog.mjs');
    expect(findParentWatchdog({}, resolve('/app/server.mjs'), at([beside]))).toBe(beside);
    expect(findParentWatchdog({}, resolve('/app/server.mjs'), at([]), '/app')).toBeNull();
    const inRoot = resolve('/app/parent-watchdog.mjs');
    expect(
      findParentWatchdog({}, resolve('/lsnode/lsnode.js'), at([inRoot]), resolve('/app')),
    ).toBe(inRoot);
    expect(
      findParentWatchdog({ TMANAGE_PARENT_WATCHDOG: '/w.mjs' }, undefined, at(['/w.mjs'])),
    ).toBe('/w.mjs');
  });
});
