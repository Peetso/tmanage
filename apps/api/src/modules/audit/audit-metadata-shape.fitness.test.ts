import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { assertSafeAuditMetadata, UnsafeAuditMetadataError } from '@tmanage/domain';
import { describe, expect, it } from 'vitest';

/**
 * DC-11 fitness check (2026-11-24). The audit write boundary (`AuditEventsRepository.append`)
 * calls `assertSafeAuditMetadata`, so an audit event whose metadata key names content (`reason`,
 * `note`, `email`, `signature`, `address`, `secret`…) or whose value is a comma- or space-joined
 * list throws at the write, and the action it records answers 500. Unit fakes of `audit.record`
 * hid eight such sites from their own tests. This parses every API source file and checks, for
 * each audit event literal (an object with both `action` and `metadata`):
 *
 * - every static metadata key, against the real validator;
 * - every `.join(sep)` value, whose separator must itself pass the value rule.
 *
 * Keys built at runtime (`${kind}_count`) cannot be read here; their producers keep their own
 * unit test with a fake that calls the real validator.
 */

const SRC_DIR = fileURLToPath(new URL('../..', import.meta.url));

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...listSourceFiles(full));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function hasProperty(literal: ts.ObjectLiteralExpression, name: string): boolean {
  return literal.properties.some(
    (p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      propertyName(p.name) === name,
  );
}

/** The object literals a metadata expression can evaluate to (spreads and `? {…} : {}`). */
function literalsOf(expression: ts.Expression): ts.ObjectLiteralExpression[] {
  let e = expression;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) {
    e = e.expression;
  }
  if (ts.isObjectLiteralExpression(e)) return [e];
  if (ts.isConditionalExpression(e)) return [...literalsOf(e.whenTrue), ...literalsOf(e.whenFalse)];
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return literalsOf(e.right);
  }
  return [];
}

function validatorRefusal(metadata: Record<string, unknown>): string[] {
  try {
    assertSafeAuditMetadata(metadata);
    return [];
  } catch (error) {
    if (error instanceof UnsafeAuditMetadataError) return [...error.violations];
    throw error;
  }
}

/** Returns `file:line message` for every unsafe metadata key or joined value in `source`. */
export function findUnsafeAuditMetadata(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const at = (node: ts.Node): string =>
    `${fileName}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;

  const checkMetadata = (literal: ts.ObjectLiteralExpression): void => {
    for (const property of literal.properties) {
      if (ts.isSpreadAssignment(property)) {
        for (const inner of literalsOf(property.expression)) checkMetadata(inner);
        continue;
      }
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
        continue;
      }
      const key = propertyName(property.name);
      if (key === undefined) continue;
      for (const violation of validatorRefusal({ [key]: null })) {
        found.push(`${at(property)} ${violation}`);
      }
      if (ts.isPropertyAssignment(property)) {
        const value = property.initializer;
        if (
          ts.isCallExpression(value) &&
          ts.isPropertyAccessExpression(value.expression) &&
          value.expression.name.text === 'join'
        ) {
          const separator = value.arguments[0];
          const text =
            separator === undefined
              ? ','
              : ts.isStringLiteralLike(separator)
                ? separator.text
                : undefined;
          if (text === undefined || validatorRefusal({ joined: `a${text}b` }).length > 0) {
            found.push(`${at(property)} '${key}' joins with a separator the audit refuses`);
          }
        }
      }
    }
  };

  // Metadata handed over by name (`metadata,` or `metadata: built`) or by a local helper
  // (`metadata: rangeMetadata(cidr)`): the same file's declarations of that name are checked.
  const byName = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node) && hasProperty(node, 'action')) {
      for (const property of node.properties) {
        if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'metadata') {
          byName.add('metadata');
        }
        if (!ts.isPropertyAssignment(property) || propertyName(property.name) !== 'metadata') {
          continue;
        }
        const value = property.initializer;
        for (const literal of literalsOf(value)) checkMetadata(literal);
        if (ts.isIdentifier(value)) byName.add(value.text);
        if (ts.isCallExpression(value) && ts.isIdentifier(value.expression)) {
          byName.add(value.expression.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const returnedLiterals = (body: ts.Node): ts.ObjectLiteralExpression[] => {
    if (ts.isExpression(body)) return literalsOf(body);
    const out: ts.ObjectLiteralExpression[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) && node !== body) return;
      if (ts.isReturnStatement(node) && node.expression) out.push(...literalsOf(node.expression));
      ts.forEachChild(node, walk);
    };
    walk(body);
    return out;
  };
  const declarations = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (byName.has(node.name.text)) {
        const init = node.initializer;
        const literals =
          ts.isArrowFunction(init) || ts.isFunctionExpression(init)
            ? returnedLiterals(init.body)
            : literalsOf(init);
        for (const literal of literals) checkMetadata(literal);
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name && node.body && byName.has(node.name.text)) {
      for (const literal of returnedLiterals(node.body)) checkMetadata(literal);
    }
    ts.forEachChild(node, declarations);
  };
  if (byName.size > 0) declarations(sf);
  return found;
}

describe('DC-11: audit event metadata passes the audit write boundary', () => {
  it('no audit event in apps/api/src names a refused key or joins with a refused separator', () => {
    const found = listSourceFiles(SRC_DIR).flatMap((file) =>
      findUnsafeAuditMetadata(
        relative(SRC_DIR, file).split(sep).join('/'),
        readFileSync(file, 'utf8'),
      ),
    );
    expect(found, found.join('\n')).toEqual([]);
  });

  it('the scan sees keys, spreads, conditionals and joins (self-test)', () => {
    const source = `
      audit.record(tx, ctx, {
        action: 'x.y',
        metadata: {
          reason: 'a',
          ok_id: 'b',
          ...(cond ? { note_count: 1 } : {}),
          fields: list.join(','),
          kinds: list.join(':'),
        },
      });`;
    const found = findUnsafeAuditMetadata('probe.ts', source);
    expect(found.some((f) => f.includes("'reason'"))).toBe(true);
    expect(found.some((f) => f.includes("'note_count'"))).toBe(true);
    expect(found.some((f) => f.includes("'fields' joins"))).toBe(true);
    expect(found.some((f) => f.includes('ok_id') || f.includes("'kinds'"))).toBe(false);
  });

  it('the scan follows metadata handed over by name or built by a local helper (self-test)', () => {
    const source = `
      function rangeMetadata(cidr: string) { return { address_range: cidr }; }
      const metadata = { title_length: 3 };
      audit.record(tx, ctx, { action: 'a.b', metadata });
      audit.record(tx, ctx, { action: 'a.c', metadata: rangeMetadata(x) });`;
    const found = findUnsafeAuditMetadata('probe.ts', source);
    expect(found.some((f) => f.includes("'title_length'"))).toBe(true);
    expect(found.some((f) => f.includes("'address_range'"))).toBe(true);
  });
});
