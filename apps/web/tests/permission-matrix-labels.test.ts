import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MATRIX, MATRIX_ACTIONS, MATRIX_AREAS } from '@tmanage/domain';
import type { Capability } from '@tmanage/domain';
import { capabilitySentence } from '../src/components/permissions/PermissionMatrix';
import type { MessageKey } from '../src/lib/i18n/t';

/**
 * Live check 0186c261 B3: the per-person permissions screen showed
 * "PermissionMatrix.cap.time.view_team" because three capabilities added to the domain matrix had
 * no sentence in the catalogs. Every capability the matrix can show — every non-empty cell of the
 * domain `MATRIX` — must have its sentence, area name and action name in English and in each
 * translated catalog, so the next capability added without labels fails here, not on screen.
 *
 * The catalogs are read from disk (not through `t()`, which falls back to English and then to the
 * key) so a missing entry is seen as missing.
 */

const CATALOGS = ['en', 'ar', 'de', 'es', 'fr', 'pt-BR', 'zh-CN'] as const;

/** The string `import.meta.url`, not a `URL`: under jsdom the global `URL` is jsdom's. */
const MESSAGES = join(dirname(fileURLToPath(import.meta.url)), '../src/lib/i18n/messages');

function catalog(name: (typeof CATALOGS)[number]): Readonly<Record<string, string>> {
  return JSON.parse(readFileSync(join(MESSAGES, `${name}.json`), 'utf8')) as Record<string, string>;
}

/** Every capability drawn in a matrix cell, once each. */
function matrixCapabilities(): Capability[] {
  const out = new Set<Capability>();
  for (const area of MATRIX_AREAS) {
    for (const action of MATRIX_ACTIONS) {
      const capability = MATRIX[area][action];
      if (capability !== null) out.add(capability);
    }
  }
  return [...out];
}

describe('permission matrix labels (live check 0186c261 B3)', () => {
  const capabilities = matrixCapabilities();

  it('the matrix shows capabilities at all', () => {
    expect(capabilities.length).toBeGreaterThan(0);
  });

  for (const name of CATALOGS) {
    it(`${name}: every capability, area and action the matrix can show has a label`, () => {
      const messages = catalog(name);
      const missing: string[] = [];
      const lookup = (key: MessageKey) => {
        const text = messages[key];
        if (text === undefined || text.trim() === '') missing.push(key);
        return text ?? '';
      };
      for (const capability of capabilities) capabilitySentence(lookup, capability);
      for (const area of MATRIX_AREAS) lookup(`PermissionMatrix.area.${area}` as MessageKey);
      for (const action of MATRIX_ACTIONS)
        lookup(`PermissionMatrix.action.${action}` as MessageKey);
      expect(missing).toEqual([]);
    });
  }
});
