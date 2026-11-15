import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { envSchema } from './env.js';
import { renderEnvReference, SECRET_ENV_KEYS } from './env-reference.js';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('self-host env reference (54-19)', () => {
  it('has a row for every schema variable, names only real secrets, and is not stale', () => {
    const committed = read('../../../docs/ops/self-host/ENV-REFERENCE.md');
    for (const name of Object.keys(envSchema.shape)) expect(committed).toContain(`| \`${name}\` |`);
    for (const name of SECRET_ENV_KEYS) expect(Object.keys(envSchema.shape)).toContain(name);
    expect(committed).toBe(renderEnvReference(read('./env.ts')));
  });
});
