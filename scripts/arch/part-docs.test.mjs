// Tests for the part-documentation system (PART-DOCS.md §3.3 gate, §6 checks PD-1…PD-7).
// One test per behaviour; each fails if the check it names is removed.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkDoc, checkPresence, checkRegistryFresh, checkStale } from './part-docs-check.mjs';
import { decide, record } from './part-docs-gate.mjs';
import {
  buildRegistry,
  findPart,
  parseFrontMatter,
  repoRelative,
  shellWriteTargets,
} from './parts-lib.mjs';

const VIEWS = `# Views\n\n## 4. Context map\n\n| Context | Modules | Owns | Up |\n| --- | --- | --- | --- |\n| Identity & Access | alpha, beta | users | all |\n\n## 5. Next\n`;

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'parts-'));
  const put = (rel, text = '') => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  put('docs/architecture/VIEWS.md', VIEWS);
  put('apps/api/main.ts');
  put('apps/api/src/modules/alpha/alpha.service.ts');
  put('apps/api/src/modules/beta/beta.service.ts');
  put('apps/web/src/app/sign-in/page.tsx');
  put('apps/web/src/app/connect/page.tsx');
  const registry = buildRegistry(root);
  put('docs/architecture/parts.json', JSON.stringify(registry));
  return { root, put, registry };
}

const ALPHA_DOC = 'apps/api/src/modules/alpha/PART.md';
const edit = (root, rel, extra = {}) => ({
  session_id: 's1',
  tool_name: 'Edit',
  tool_input: { file_path: path.join(root, rel) },
  cwd: root,
  ...extra,
});
const readLine = (root, rel, agentId) =>
  JSON.stringify({
    ...(agentId ? { agentId } : {}),
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(root, rel) } }],
    },
  });

test('mapping: longest prefix wins, Windows backslashes and drive-letter case are normalised', () => {
  const { root, registry } = fixture();
  const win = path.join(root, 'apps/api/src/modules/alpha/alpha.service.ts').replace(/\//g, '\\');
  const flipped = win.replace(/^[a-z]/i, (c) =>
    c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase(),
  );
  assert.equal(findPart(registry, repoRelative(flipped, root)).id, 'api/alpha');
  assert.equal(findPart(registry, 'apps/api/main.ts').id, 'app/api');
  assert.equal(findPart(registry, 'README.md'), null);
  assert.equal(repoRelative(path.join(root, '..', 'elsewhere.ts'), root), null);
});

test('registry: a multi-folder part gets one loader per folder importing its single PART.md', () => {
  const { registry } = fixture();
  const auth = registry.parts.find((p) => p.id === 'web/auth');
  assert.equal(auth.doc, 'apps/web/src/app/sign-in/PART.md');
  assert.deepEqual(
    auth.loaders.map((l) => l.import),
    ['@PART.md', '@../sign-in/PART.md'],
  );
  assert.equal(registry.parts.find((p) => p.id === 'api/alpha').context, 'identity-and-access');
});

test('gate: PART.md, CLAUDE.md, docs/** and paths outside every part are exempt', () => {
  const { root } = fixture();
  for (const rel of [ALPHA_DOC, 'apps/api/src/modules/alpha/CLAUDE.md', 'docs/x.md', 'README.md']) {
    assert.equal(decide(edit(root, rel), root).action, 'allow', rel);
  }
});

test('gate: a part without its PART.md yet is allowed with a reminder', () => {
  const { root } = fixture();
  const result = decide(edit(root, 'apps/api/src/modules/alpha/alpha.service.ts'), root);
  assert.equal(result.action, 'remind');
  assert.match(result.message, /api\/alpha has no/);
});

test('gate: a documented part is denied until its PART.md is read', () => {
  const { root, put } = fixture();
  put(ALPHA_DOC, '# doc');
  const result = decide(edit(root, 'apps/api/src/modules/alpha/alpha.service.ts'), root);
  assert.equal(result.action, 'deny');
  assert.match(result.message, /Read apps\/api\/src\/modules\/alpha\/PART\.md first/);
});

test("gate: the session transcript's Read of the PART.md allows the edit", () => {
  const { root, put } = fixture();
  put(ALPHA_DOC, '# doc');
  put('t/s1.jsonl', `${readLine(root, ALPHA_DOC)}\n`);
  const input = edit(root, 'apps/api/src/modules/alpha/alpha.service.ts', {
    transcript_path: path.join(root, 't/s1.jsonl'),
  });
  assert.equal(decide(input, root).action, 'allow');
});

test("gate: a subagent needs its own read; the manager's read does not count for it", () => {
  const { root, put } = fixture();
  put(ALPHA_DOC, '# doc');
  put('t/s1.jsonl', `${readLine(root, ALPHA_DOC)}\n`);
  const input = edit(root, 'apps/api/src/modules/alpha/alpha.service.ts', {
    transcript_path: path.join(root, 't/s1.jsonl'),
    agent_id: 'a9',
  });
  assert.equal(decide(input, root).action, 'deny');
  put('t/s1/subagents/agent-a9.jsonl', `${readLine(root, ALPHA_DOC, 'a9')}\n`);
  assert.equal(decide(input, root).action, 'allow');
});

test('gate: the PostToolUse(Read) record allows the edit without a transcript', () => {
  const { root, put } = fixture();
  put(ALPHA_DOC, '# doc');
  const read = {
    session_id: 's1',
    tool_name: 'Read',
    tool_input: { file_path: path.join(root, ALPHA_DOC) },
  };
  assert.equal(record(read, root), true);
  assert.equal(
    decide(edit(root, 'apps/api/src/modules/alpha/alpha.service.ts'), root).action,
    'allow',
  );
  const other = edit(root, 'apps/api/src/modules/alpha/alpha.service.ts', { session_id: 's2' });
  assert.equal(decide(other, root).action, 'deny');
});

test('gate: a malformed registry fails closed', () => {
  const { root, put } = fixture();
  put('docs/architecture/parts.json', '{ not json');
  const result = decide(edit(root, 'apps/api/src/modules/alpha/alpha.service.ts'), root);
  assert.equal(result.action, 'deny');
  assert.match(result.message, /missing or malformed/);
});

test('gate: shell writes into a documented part are gated, shell reads are not', () => {
  const { root, put } = fixture();
  put(ALPHA_DOC, '# doc');
  const shell = (command) => ({
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command },
    cwd: root,
  });
  assert.equal(decide(shell('echo x > apps/api/src/modules/alpha/a.ts'), root).action, 'deny');
  assert.equal(
    decide(shell("sed -i 's/a/b/' apps/api/src/modules/alpha/a.ts"), root).action,
    'deny',
  );
  assert.equal(
    decide(shell('grep foo apps/api/src/modules/alpha/a.ts 2>&1'), root).action,
    'allow',
  );
  assert.deepEqual(shellWriteTargets('Set-Content -Path "x.ts" -Value 1'), ['x.ts']);
});

test('PD-1: the baseline ratchet only shrinks and never holds a P0 part', () => {
  const { root, put, registry } = fixture();
  const rules = (errors) => errors.map((e) => `${e.part}:${e.message.split(' ')[0]}`);
  // missing and not listed
  assert.ok(checkPresence(root, registry, [], null).some((e) => e.part === 'api/alpha'));
  // grew against HEAD
  assert.ok(checkPresence(root, registry, ['api/alpha'], []).some((e) => /grew/.test(e.message)));
  // P0 listed
  const p0 = {
    parts: [
      ...registry.parts,
      { id: 'api/identity', doc: 'x/PART.md', paths: ['x/'], loaders: [] },
    ],
  };
  assert.ok(checkPresence(root, p0, ['api/identity'], null).some((e) => /P0/.test(e.message)));
  // documented but still listed, and its loader missing
  put(ALPHA_DOC, '# doc');
  const errors = checkPresence(root, registry, ['api/alpha'], null);
  assert.ok(
    errors.some((e) => /remove "api\/alpha"/.test(e.message)),
    rules(errors).join(),
  );
  assert.ok(errors.some((e) => /CLAUDE\.md must exist/.test(e.message)));
  put('apps/api/src/modules/alpha/CLAUDE.md', '@PART.md\n');
  assert.equal(
    checkPresence(root, registry, [], null).filter((e) => e.part === 'api/alpha').length,
    0,
  );
});

test('PD-1: a registry that no longer matches the directory tree fails', () => {
  const { root, put } = fixture();
  assert.deepEqual(checkRegistryFresh(root, buildRegistry(root)), []);
  put('apps/api/src/modules/gamma/g.ts');
  assert.match(checkRegistryFresh(root, buildRegistry(root))[0].message, /out of date/);
});

const HEADINGS = readFileSync(
  new URL('../../docs/architecture/PART-TEMPLATE.md', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter((l) => l.startsWith('## '))
  .filter((l) => !l.includes('Glossary'));
const ctx = {
  contexts: new Set(['identity-and-access']),
  ruleIds: new Set(['SE-2']),
  prefixes: new Set(['SE']),
};
const alpha = {
  id: 'api/alpha',
  kind: 'api-module',
  doc: ALPHA_DOC,
  context: 'identity-and-access',
};
const goodDoc = (overrides = {}, body = HEADINGS.map((h) => `${h}\n\nText SE-2.\n`).join('\n')) => {
  const fm = {
    part: 'api/alpha',
    kind: 'api-module',
    context: 'identity-and-access',
    owner: 'implementation-lead',
    lifecycle: 'production',
    depends_on: '[]',
    provides_api: '[]',
    consumes_api: '[]',
    tables_owned: '[]',
    rules: '[SE-2]',
    last_verified_commit: 'abc1234',
    last_verified_date: '2026-11-20',
    last_verified_by: 'opus',
    ...overrides,
  };
  return `---\n${Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n---\n\n# alpha\n\n${body}`;
};

test('PD-2/3/4/7: a complete doc passes; each defect is reported under its rule', () => {
  assert.deepEqual(checkDoc(alpha, goodDoc(), ctx), []);
  const rule = (text) => checkDoc(alpha, text, ctx).map((e) => e.rule);
  assert.deepEqual(rule(goodDoc({ part: 'api/beta' })), ['PD-2']);
  assert.deepEqual(rule(goodDoc({ context: 'billing' })), ['PD-2']);
  assert.deepEqual(rule(goodDoc({ rules: '[SE-99]' })), ['PD-4']);
  const noPurpose = HEADINGS.slice(1)
    .map((h) => `${h}\n\nText.\n`)
    .join('\n');
  assert.deepEqual(rule(goodDoc({}, noPurpose)), ['PD-3']);
  const bareNa = HEADINGS.map((h, i) => `${h}\n\n${i === 6 ? 'n/a' : 'Text.'}\n`).join('\n');
  assert.deepEqual(rule(goodDoc({}, bareNa)), ['PD-3']);
  const withReason = HEADINGS.map(
    (h, i) => `${h}\n\n${i === 6 ? 'n/a — no screens' : 'Text.'}\n`,
  ).join('\n');
  assert.deepEqual(rule(goodDoc({}, withReason)), []);
  assert.ok(
    rule(goodDoc({}, `${HEADINGS.join('\n\nx\n')}\n\n${'x'.repeat(30_001)}`)).includes('PD-7'),
  );
});

test('PD-5: more than 15 commits since last_verified_commit, or a non-ancestor sha, fails', () => {
  const { registry } = fixture();
  const p = registry.parts.find((x) => x.id === 'api/alpha');
  const data = { last_verified_commit: 'abc1234' };
  const gitApi = (count, ancestor = true) => ({
    isAncestor: () => ancestor,
    countSince: () => count,
  });
  const warnings = [];
  assert.deepEqual(checkStale(p, data, registry, gitApi(15), warnings), []);
  assert.equal(warnings.length, 1);
  assert.equal(checkStale(p, data, registry, gitApi(16), []).length, 1);
  assert.match(checkStale(p, data, registry, gitApi(0, false), [])[0].message, /not an ancestor/);
});

test('PD-2: front-matter lists parse in all three forms Prettier writes', () => {
  const text = [
    '---',
    "inline: [a, '/v1/x/{b,c}']",
    'block:',
    "  - '/v1/y'",
    'wrapped:',
    '  [',
    '    t1,',
    '    t2,',
    '  ]',
    '---',
    '',
  ].join('\n');
  const { data, error } = parseFrontMatter(text);
  assert.equal(error, null);
  assert.deepEqual(data, { inline: ['a', '/v1/x/{b,c}'], block: ['/v1/y'], wrapped: ['t1', 't2'] });
});
