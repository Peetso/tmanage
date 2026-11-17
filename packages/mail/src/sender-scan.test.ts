import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * EMAILBUILD. No request can name a mail's sender: no controller, DTO or contract outside the
 * people registry mentions the server-only sender fields. Fails the moment one does.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SENDER_FIELD =
  /\bactingFor\b|\bsenderCategory\b|\bfrom\s*:\s*\{\s*name\b|\baudience\s*:\s*'client'/u;

function files(dir: string, keep: (path: string) => boolean): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((path) => join(dir, path))
    .filter((path) => keep(path.replaceAll('\\', '/')));
}

describe('EMAILBUILD — the sender never comes from request input', () => {
  it('no controller, DTO or contract names a sender field', () => {
    const api = files(
      join(ROOT, 'apps/api/src'),
      (path) => /\.(controller|dto|schema)\.ts$/u.test(path) && !path.includes('/mail-people'),
    );
    const contracts = files(join(ROOT, 'packages/contracts/src'), (path) => path.endsWith('.ts'));
    expect(api.length).toBeGreaterThan(10);
    const code = (path: string) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line))
        .join('\n');
    const offenders = [...api, ...contracts].filter((path) => SENDER_FIELD.test(code(path)));
    expect(offenders).toEqual([]);
  });
});
