import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Readers for the immutable design export.
 *
 * `docs/design/source/` is byte-identical to the design handoff in the planning pack and
 * is never written to. These tests read it as evidence, which is the only relationship
 * this repository is allowed to have with it.
 */
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const designTokens = join(packageRoot, '../../docs/design/source/project/design/tokens');

export function readDesignTokensJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(designTokens, 'tokens.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

export function readDesignTokensCss(): string {
  return readFileSync(join(designTokens, 'tokens.css'), 'utf8');
}

export function readPackageTokensCss(): string {
  return readFileSync(join(packageRoot, 'src/styles/tokens.css'), 'utf8');
}

export type CustomProperties = Map<string, string>;
export type Stylesheet = Map<string, CustomProperties>;

function normalizeValue(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

function normalizeSelector(selector: string): string {
  return selector.replace(/["']/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * A small CSS reader — enough for a token sheet, and no more.
 *
 * It returns only custom properties, keyed by selector, with `@media` conditions folded
 * into the selector so a value declared under `prefers-reduced-motion` is never compared
 * against the unconditional one.
 */
export function parseCustomProperties(css: string, prefix = ''): Stylesheet {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const sheet: Stylesheet = new Map();

  let buffer = '';
  let index = 0;

  while (index < source.length) {
    const character = source[index];

    if (character !== '{') {
      buffer += character;
      index += 1;
      continue;
    }

    const selector = buffer.trim();
    buffer = '';

    let depth = 1;
    let end = index + 1;
    while (end < source.length && depth > 0) {
      if (source[end] === '{') depth += 1;
      else if (source[end] === '}') depth -= 1;
      end += 1;
    }

    const body = source.slice(index + 1, end - 1);

    if (selector.startsWith('@')) {
      for (const [nestedSelector, declarations] of parseCustomProperties(
        body,
        `${prefix}${selector} `,
      )) {
        sheet.set(nestedSelector, declarations);
      }
    } else {
      const declarations: CustomProperties = new Map();
      for (const declaration of body.split(';')) {
        const separator = declaration.indexOf(':');
        if (separator === -1) continue;
        const name = declaration.slice(0, separator).trim();
        if (!name.startsWith('--')) continue;
        declarations.set(name, normalizeValue(declaration.slice(separator + 1)));
      }
      sheet.set(normalizeSelector(`${prefix}${selector}`), declarations);
    }

    index = end;
  }

  return sheet;
}
