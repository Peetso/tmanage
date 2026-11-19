import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 62-27 (B05) — "zero model calls", asserted. The signals engine is rows and rules: from every
 * entry point of the feature (domain rules, the sweep, its stores, the notice consumer, the
 * settings API, the Home briefing and its mail section) the transitive closure of relative imports may reach no model client, no AI SDK
 * package and no HTTP client. A future import of the copilot, an AI SDK or a network call into
 * this code fails here before it can spend anything.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const ENTRY_POINTS = [
  ...readdirSync(join(ROOT, 'packages/domain/src/signals'))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => `packages/domain/src/signals/${name}`),
  'packages/domain/src/flags/flag-chain.ts',
  'apps/worker/src/jobs/signals-sweeper.ts',
  'apps/worker/src/common/database/signals-store.ts',
  'apps/worker/src/common/database/signal-notice-store.ts',
  'apps/worker/src/common/database/feature-flag-store.ts',
  'apps/worker/src/consumers/work-signal-notice.ts',
  'apps/api/src/modules/insights/signals.controller.ts',
  'apps/api/src/modules/insights/signals.service.ts',
  'apps/api/src/modules/insights/signals.repository.ts',
  // 62-A1b (B11): the Home business briefing.
  'apps/api/src/modules/home/home-briefing.controller.ts',
  'apps/api/src/modules/home/home-briefing.service.ts',
  'apps/api/src/modules/home/home-briefing.repository.ts',
  // 62-A1c (B12): the briefing in the digest mail.
  'apps/worker/src/common/database/briefing-store.ts',
  'apps/worker/src/common/database/notification-digest-store.ts',
  'apps/worker/src/notifications/briefing-mail.ts',
  'apps/worker/src/notifications/digest-mailer.ts',
];

/** AI SDKs and HTTP clients: none may be imported anywhere in the closure. */
const FORBIDDEN_PACKAGE =
  /anthropic|openai|@google\/genai|generative-ai|cohere|mistral|ollama|langchain|axios|undici|node-fetch|^node:https?$|^https?$/i;

const MODEL_CLIENT = /anthropic|openai|copilot|ai-client|ai-provider|ai-actions|llm|claude|gemini/i;

const IMPORT = /^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm;

function importsOf(source: string): string[] {
  return [...source.matchAll(IMPORT)].map((match) => match[1]!);
}

/** Every file reachable from the entry points through relative imports, and every package import. */
function closure(): { files: Set<string>; packages: Map<string, string> } {
  const files = new Set<string>();
  const packages = new Map<string, string>();
  const queue = ENTRY_POINTS.map((path) => join(ROOT, path));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        queue.push(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
      } else {
        packages.set(specifier, file);
      }
    }
  }
  return { files, packages };
}

describe('signals engine: no model call', () => {
  const { files, packages } = closure();

  it('reaches no model client through any relative import', () => {
    const offenders = [...files].filter((file) => MODEL_CLIENT.test(file.slice(ROOT.length)));
    expect(offenders).toEqual([]);
    expect(files.size).toBeGreaterThan(ENTRY_POINTS.length);
  });

  it('imports no AI SDK and no HTTP client package', () => {
    expect([...packages.keys()].filter((name) => FORBIDDEN_PACKAGE.test(name))).toEqual([]);
    expect(packages.has('@tmanage/domain')).toBe(true);
  });

  it('makes no network call', () => {
    const calls = [...files].filter((file) =>
      /\bfetch\(|https?\.request\(|new WebSocket\(/.test(readFileSync(file, 'utf8')),
    );
    expect(calls).toEqual([]);
  });

  it('the domain package has no runtime dependency a model client could hide in', () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, 'packages/domain/package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies ?? {}).toEqual({});
  });
});
