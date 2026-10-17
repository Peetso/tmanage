import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Provider } from '@nestjs/common';
import { LOCAL_PART_SINK, OBJECT_STORE } from '../http/tokens.js';
import { StorageModule } from './storage.module.js';
import type { StorageModuleConfig } from './storage.module.js';

/**
 * `StorageModule.forConfig` is where `STORAGE_DRIVER=local` meets its root check: a root
 * inside a web root, or a relative one, must fail the wiring (and so the boot), not the
 * first upload. Plain unit — no Nest app, no database; the returned providers are inspected.
 */

function tokensOf(providers: readonly Provider[] | undefined): unknown[] {
  return (providers ?? []).map((p) => (typeof p === 'object' && 'provide' in p ? p.provide : p));
}

describe('StorageModule.forConfig', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'tmanage-storage-module-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const configFor = (overrides: Partial<StorageModuleConfig>): StorageModuleConfig => ({
    driver: 'local',
    root: join(base, 'store'),
    webRoots: [join(base, 'public_html')],
    signingSecret: 'unit-test-signing-secret-not-a-real-one',
    publicUrl: 'http://localhost:3001',
    partSizeBytes: 5 * 1024 * 1024,
    ...overrides,
  });

  it('refuses a local root inside a web root', () => {
    expect(() =>
      StorageModule.forConfig(configFor({ root: join(base, 'public_html', 'store') })),
    ).toThrow(/STORAGE_LOCAL_ROOT is not safe/);
  });

  it('refuses a relative local root', () => {
    expect(() => StorageModule.forConfig(configFor({ root: 'relative/store' }))).toThrow(
      /STORAGE_LOCAL_ROOT is not safe/,
    );
  });

  it('wires a safe local root as both the object store and the part sink', () => {
    const tokens = tokensOf(StorageModule.forConfig(configFor({})).providers);
    expect(tokens).toContain(OBJECT_STORE);
    expect(tokens).toContain(LOCAL_PART_SINK);
  });

  it('leaves the part sink unbound for s3', () => {
    const tokens = tokensOf(StorageModule.forConfig(configFor({ driver: 's3' })).providers);
    expect(tokens).toContain(OBJECT_STORE);
    expect(tokens).not.toContain(LOCAL_PART_SINK);
  });
});
