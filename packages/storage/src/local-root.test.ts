import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FORBIDDEN_ROOT_SEGMENTS,
  prepareLocalStorageRoot,
  UnsafeStorageRootError,
} from './local-root.js';

const tmpIsClean = [tmpdir(), realpathSync(tmpdir())].every((candidate) =>
  candidate.split(sep).every((segment) => !FORBIDDEN_ROOT_SEGMENTS.includes(segment.toLowerCase())),
);

describe.skipIf(!tmpIsClean)('prepareLocalStorageRoot', () => {
  let base = '';

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'tmanage-local-root-'));
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('refuses a relative path', () => {
    expect(() => prepareLocalStorageRoot('storage/uploads')).toThrow(UnsafeStorageRootError);
    expect(() => prepareLocalStorageRoot('storage/uploads')).toThrow(/must be an absolute path/);
  });

  it('refuses a root under public_html', () => {
    expect(() => prepareLocalStorageRoot(join(base, 'public_html', 'store'))).toThrow(
      /outside public_html and any web root/,
    );
  });

  it('refuses a root under www', () => {
    expect(() => prepareLocalStorageRoot(join(base, 'www', 'x'))).toThrow(UnsafeStorageRootError);
  });

  it('refuses a root inside a configured web root', () => {
    const webRoot = join(base, 'site');
    mkdirSync(webRoot, { recursive: true });
    expect(() =>
      prepareLocalStorageRoot(join(webRoot, 'uploads'), { webRoots: [webRoot] }),
    ).toThrow(/must be outside the web root/);
  });

  it('creates a clean root and answers its real path', () => {
    const root = join(base, 'tmanage-storage');
    const real = prepareLocalStorageRoot(root, { webRoots: [join(base, 'missing-web-root')] });
    expect(real).toBe(realpathSync(root));
    expect(statSync(real).isDirectory()).toBe(true);
  });
});
