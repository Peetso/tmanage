import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * NEWMAIL (2026-11-17): the product moved to tmanageapp.com. No old contact address may come back
 * into the catalogs, the legal sources or security.txt.
 */
const OLD_ADDRESS = /[\w.+-]+@(?:[\w-]+\.)*(?:peetrix\.com|tmanage\.app)\b/giu;

const web = process.cwd();
const messagesDir = join(web, 'src', 'lib', 'i18n', 'messages');
const legalDir = join(web, '..', '..', 'packages', 'domain', 'src', 'legal');

const sources: readonly string[] = [
  ...readdirSync(messagesDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(messagesDir, name)),
  join(legalDir, 'legal-content.ts'),
  join(legalDir, 'legal-content-ar.ts'),
  join(web, 'public', '.well-known', 'security.txt'),
];

describe('no old contact address in the public copy', () => {
  it.each(sources)('%s', (path) => {
    expect(readFileSync(path, 'utf8').match(OLD_ADDRESS)).toBeNull();
  });
});
