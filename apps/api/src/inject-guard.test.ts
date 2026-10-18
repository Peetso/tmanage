import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Static DI guard (ADR-0003).
 *
 * `emitDecoratorMetadata` is off: tsx, esbuild and vitest do not emit `design:paramtypes`,
 * so a constructor parameter in a Nest-managed class without an explicit `@Inject(TOKEN)`
 * resolves to `undefined` and the route 500s at runtime — after typecheck and build passed.
 * This test parses every source file and fails listing each such parameter.
 */

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));
const MANAGED_DECORATORS = new Set(['Controller', 'Injectable', 'Catch']);

function decoratorName(decorator: ts.Decorator): string | undefined {
  const expr = decorator.expression;
  const callee = ts.isCallExpression(expr) ? expr.expression : expr;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

function decoratorsOf(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

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

/** Returns `file:line Class.constructor(param)` for every un-injected parameter in `source`. */
export function findMissingInjects(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const misses: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const managed = decoratorsOf(node).some((d) =>
        MANAGED_DECORATORS.has(decoratorName(d) ?? ''),
      );
      if (managed) {
        for (const member of node.members) {
          if (!ts.isConstructorDeclaration(member)) continue;
          for (const param of member.parameters) {
            const injected = decoratorsOf(param).some((d) => decoratorName(d) === 'Inject');
            if (injected) continue;
            const line = sf.getLineAndCharacterOfPosition(param.getStart(sf)).line + 1;
            const className = node.name?.text ?? '<anonymous>';
            misses.push(`${fileName}:${line} ${className}.constructor(${param.name.getText(sf)})`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return misses;
}

describe('DI guard: every constructor parameter of a Nest-managed class has @Inject', () => {
  it('detects a missing @Inject (self-check)', () => {
    const bad = `
      @Injectable() class A { constructor(private readonly b: B) {} }
      @Controller('x') class C { constructor(@Inject(B) private readonly b: B, @Optional() o: O) {} }
      @Injectable() class D { constructor(@Inject(B) b: B) {} }
      class Plain { constructor(b: B) {} }
    `;
    expect(findMissingInjects('fixture.ts', bad)).toEqual([
      'fixture.ts:2 A.constructor(b)',
      'fixture.ts:3 C.constructor(o)',
    ]);
  });

  // Parses every source file: ~2 s alone, but well past the 5 s default when the machine is busy.
  it('finds no un-injected constructor parameters in apps/api/src', { timeout: 30_000 }, () => {
    const misses = listSourceFiles(SRC_DIR).flatMap((file) =>
      findMissingInjects(relative(SRC_DIR, file).split(sep).join('/'), readFileSync(file, 'utf8')),
    );
    expect(misses, `Add @Inject(TOKEN) to:\n${misses.join('\n')}`).toEqual([]);
  });
});
