import type { ValueProvider } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { ERASURE_DATABASE, TENANT_DATABASE } from '../http/tokens.js';
import { DatabaseModule } from './database.module.js';
import { TenantDatabase } from './tenant-context.js';

/** PURGEFIX — the erasure database is its own pool when one is given, else the runtime's. */

function valueOf(module: ReturnType<typeof DatabaseModule.forPool>, token: symbol): unknown {
  const provider = module.providers?.find(
    (candidate): candidate is ValueProvider =>
      typeof candidate === 'object' && 'provide' in candidate && candidate.provide === token,
  );
  return provider?.useValue;
}

function fakePool(ended: string[], name: string): Pool {
  return {
    end: () => {
      ended.push(name);
      return Promise.resolve();
    },
  } as unknown as Pool;
}

describe('DatabaseModule — ERASURE_DATABASE', () => {
  it('is the runtime TenantDatabase itself when no erasure pool is given', () => {
    const module = DatabaseModule.forPool({ pool: fakePool([], 'runtime'), guardMode: 'enforce' });
    expect(valueOf(module, TENANT_DATABASE)).toBeInstanceOf(TenantDatabase);
    expect(valueOf(module, ERASURE_DATABASE)).toBe(valueOf(module, TENANT_DATABASE));
  });

  it('is a TenantDatabase over the erasure pool when one is given', async () => {
    const ended: string[] = [];
    const module = DatabaseModule.forPool({
      pool: fakePool(ended, 'runtime'),
      erasurePool: fakePool(ended, 'erasure'),
      guardMode: 'enforce',
    });
    const erasure = valueOf(module, ERASURE_DATABASE) as TenantDatabase;
    expect(erasure).toBeInstanceOf(TenantDatabase);
    await erasure.end();
    expect(ended).toEqual(['erasure']);
  });
});
