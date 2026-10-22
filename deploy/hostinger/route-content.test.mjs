// Run: node --test deploy/hostinger/route-content.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dirtyBundleInputs, isFreshBuild, routeContentProblems } from './build.mjs';

const COMMUNICATION =
  '<title>Chat &amp; calendar · TManage</title><h1>Conversations that end in commitments.</h1>';
const STATUS =
  '<title>Service status · TManage</title><p class="tm-pub-eyebrow">Status</p><h1>Service status</h1>';
const PRIVACY = '<title>TManage</title><h1>Privacy Policy</h1><p>Effective 2026-10-18</p>';
const SETUP = '<h1>Create the owner account</h1><p>You need the setup token from the server.</p>';

test('each page passes with its own content', () => {
  assert.deepEqual(routeContentProblems('/features/communication', COMMUNICATION), []);
  assert.deepEqual(routeContentProblems('/status', STATUS), []);
  assert.deepEqual(routeContentProblems('/legal/privacy', PRIVACY), []);
});

test('/features/communication serving the Privacy Policy fails', () => {
  const problems = routeContentProblems('/features/communication', PRIVACY);
  assert.ok(problems.includes("/features/communication is missing 'Chat & calendar'"));
  assert.ok(problems.includes("/features/communication contains 'Privacy Policy'"));
});

test('/status serving the setup screen inside its own chrome fails', () => {
  const problems = routeContentProblems(
    '/status',
    `<title>Service status · TManage</title>${SETUP}`,
  );
  assert.ok(problems.includes("/status contains 'setup token'"));
  assert.ok(problems.includes("/status is missing 'tm-pub-eyebrow\">Status<'"));
});

test('a path without a rule is reported, not passed', () => {
  assert.deepEqual(routeContentProblems('/nowhere', COMMUNICATION), [
    'no content rule for /nowhere',
  ]);
});

test('dirtyBundleInputs keeps only the paths that feed the bundle', () => {
  const porcelain = [
    ' M apps/web/src/components/screens/FirstProjectScreen.tsx',
    '?? apps/web/src/lib/api/project-client.ts',
    ' M pnpm-lock.yaml',
    'R  packages/ui/a.ts -> packages/ui/b.ts',
    ' M docs/planning/notes.md',
    '?? deploy/hostinger/out/stage/x',
    ' M package.json.bak',
    '',
  ].join('\n');
  assert.deepEqual(dirtyBundleInputs(porcelain), [
    'apps/web/src/components/screens/FirstProjectScreen.tsx',
    'apps/web/src/lib/api/project-client.ts',
    'pnpm-lock.yaml',
    'packages/ui/b.ts',
  ]);
  assert.deepEqual(dirtyBundleInputs(''), []);
});

test('a BUILD_ID older than the run is not a fresh build', () => {
  assert.equal(isFreshBuild(1_000, 2_000), false);
  assert.equal(isFreshBuild(2_000, 2_000), true);
  assert.equal(isFreshBuild(3_000, 2_000), true);
});
