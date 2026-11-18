import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LEGAL_COPY_AR } from '@tmanage/domain';
import ar from '../src/lib/i18n/messages/ar.json';
import ur from '../src/lib/i18n/messages/ur.json';
import { ACCESSIBILITY_COPY } from '../src/content/accessibility/accessibility-copy';
import { HELP_ARTICLES } from '../src/content/help/help-articles';

/**
 * A right-to-left line (Arabic or Urdu script) that opens on a Latin brand name ("TManage …",
 * "Google Drive …") is laid out left to right by the browser unless it starts with U+200F (or
 * U+061C). `e2e/tests/ar-public-pages` proves it on the rendered pages; this guard catches the copy
 * in every right-to-left source before it gets there.
 *
 * The brand list is the one the e2e check uses, read as a file: tests may not import domain sources.
 */
const BRANDS = (
  JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../../../packages/domain/src/i18n/glossary.json',
      ),
      'utf8',
    ),
  ) as { brands: readonly string[] }
).brands;

const RTL_SCRIPT = /[\u0600-\u06FF]/u;

function strings(value: unknown, at: string, out: Array<[string, string]>): void {
  if (typeof value === 'string') out.push([at, value]);
  else if (Array.isArray(value))
    value.forEach((item, index) => strings(item, `${at}[${index}]`, out));
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) strings(item, at ? `${at}.${key}` : key, out);
  }
}

function unmarkedLatinLed(source: unknown): string[] {
  const all: Array<[string, string]> = [];
  strings(source, '', all);
  return all
    .filter(([, text]) => {
      const line = text.trimStart();
      return (
        RTL_SCRIPT.test(line) &&
        !line.startsWith('\u200F') &&
        !line.startsWith('\u061C') &&
        BRANDS.some((brand) => line.startsWith(brand))
      );
    })
    .map(([at]) => at);
}

describe('Right-to-left lines led by a Latin brand carry a right-to-left mark', () => {
  it.each([
    ['the ar.json catalog', ar],
    ['the ur.json catalog', ur],
    ['the Arabic legal copy', LEGAL_COPY_AR],
    ['the Arabic help articles', HELP_ARTICLES.map((article) => article.ar)],
    ['the Arabic accessibility page', ACCESSIBILITY_COPY.ar],
  ])('in %s', (_source, copy) => {
    expect(unmarkedLatinLed(copy)).toEqual([]);
  });
});
