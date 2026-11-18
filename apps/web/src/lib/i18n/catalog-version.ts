import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CATSPLIT, build time only (`next.config.ts`): a short hash of every catalog and of the part
 * split, inlined as `NEXT_PUBLIC_CATALOG_VERSION`. The browser asks for each catalog part under it
 * (`catalog-part-path.ts`), so a part cached for a year is replaced by the next deploy that
 * changes a word.
 */
export function catalogVersion(i18nDir: string): string {
  const hash = createHash('sha256');
  const messages = join(i18nDir, 'messages');
  for (const name of readdirSync(messages).sort()) hash.update(readFileSync(join(messages, name)));
  hash.update(readFileSync(join(i18nDir, 'catalog-app-namespaces.ts')));
  return hash.digest('hex').slice(0, 12);
}
