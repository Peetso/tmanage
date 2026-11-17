import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 56-06 (R19-e), 52-20a and 54-12a: every door a file comes in through imports the one
 * `file-safety` module, so the rule is never copied. Read from the sources, by import line.
 * 54-12's inbound-mail module is listed and skipped while it does not exist.
 */
const modules = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMPORTS_FILE_SAFETY = /from '(?:\.\/|\.\.\/files\/)file-safety\.js'/u;

// 52-20a: a public form's attachments open through `FilesService.createForPublicForm`, so the
// files service is that door's consumer too; the public-forms module holds no copy of the rule.
const CONSUMERS = ['files/files.service.ts', 'inbound-mail/inbound-mail.service.ts'] as const;

describe('file-safety consumers', () => {
  it.each(CONSUMERS)('%s imports the shared module', (relative) => {
    const path = resolve(modules, relative);
    if (!existsSync(path)) {
      // 54-12 is not built yet; it joins this list the day it is.
      expect(relative.startsWith('inbound-mail/')).toBe(true);
      return;
    }
    expect(readFileSync(path, 'utf8')).toMatch(IMPORTS_FILE_SAFETY);
  });
});
