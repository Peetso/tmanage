import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnsafeObjectPathError } from './errors.js';
import {
  assertRealPathUnder,
  assertSafeObjectKey,
  assertTenantKey,
  resolveUnder,
  tenantOfObjectKey,
} from './local-path.js';
import { uploadObjectKey } from './object-key.js';

const ORG = '11111111-2222-4333-8444-555555555555';
const OTHER_ORG = '99999999-2222-4333-8444-555555555555';
const KEY = uploadObjectKey({
  organizationId: ORG,
  projectId: '22222222-2222-4333-8444-555555555555',
  uploadId: '33333333-2222-4333-8444-555555555555',
});

// A junction needs no privilege on Windows; a symlink without Developer Mode is EPERM there.
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';
const canSymlink = (() => {
  const probe = mkdtempSync(path.join(tmpdir(), 'tm-symlink-probe-'));
  try {
    symlinkSync(probe, path.join(probe, 'link'), LINK_TYPE);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

describe('assertSafeObjectKey', () => {
  it.each([
    ['a parent segment', '..'],
    ['an embedded parent segment', 'a/../b'],
    ['an absolute path', '/etc/passwd'],
    ['a drive letter', 'C:/x'],
    ['a backslash', 'a\\b'],
    ['a NUL', 'a\u0000b'],
    ['the empty key', ''],
    ['an empty segment', 'a//b'],
  ])('refuses %s', (_label, key) => {
    expect(() => assertSafeObjectKey(key)).toThrow(UnsafeObjectPathError);
  });

  it('accepts a key built by uploadObjectKey and returns its segments', () => {
    expect(assertSafeObjectKey(KEY)).toEqual(KEY.split('/'));
  });
});

describe('resolveUnder', () => {
  it('refuses segments that resolve to the base itself', () => {
    expect(() => resolveUnder('/srv/root', ['a', '..'])).toThrow(UnsafeObjectPathError);
  });
});

describe('assertRealPathUnder', () => {
  let root: string;
  let outside: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'tm-local-root-'));
    outside = await mkdtemp(path.join(tmpdir(), 'tm-local-out-'));
    await mkdir(path.join(root, 'inside'));
    if (canSymlink) await symlink(outside, path.join(root, 'escape'), LINK_TYPE);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('accepts a not-yet-existing file under a real directory in the root', async () => {
    await expect(
      assertRealPathUnder(root, path.join(root, 'inside', 'new', 'object')),
    ).resolves.toBeUndefined();
  });

  it.skipIf(!canSymlink)(
    'refuses a path through a symlinked directory that points outside the root',
    async () => {
      await expect(assertRealPathUnder(root, path.join(root, 'escape', 'object'))).rejects.toThrow(
        UnsafeObjectPathError,
      );
    },
  );
});

describe('tenant binding', () => {
  it('reads the organization from a tenant key and accepts its own organization', () => {
    expect(tenantOfObjectKey(KEY)).toBe(ORG);
    expect(() => assertTenantKey(KEY, ORG)).not.toThrow();
  });

  it('refuses a key of another organization and a key outside the tenant prefix', () => {
    expect(tenantOfObjectKey('project/x/object')).toBeNull();
    expect(() => assertTenantKey(KEY, OTHER_ORG)).toThrow(UnsafeObjectPathError);
  });
});
