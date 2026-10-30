// Run: node --test scripts/security/supply-chain.test.mjs — 56-14 supply-chain scripts.
// (The MCP bridge hash file is covered by deploy/hostinger/mcp-bridge.test.mjs.)
import assert from 'node:assert/strict';
import test from 'node:test';

import { checkLicenses, isDeniedLicense } from './license-check.mjs';
import { checkPolicy, readPolicyInputs, satisfiesRange } from './lockfile-policy.mjs';
import { toCycloneDx } from './sbom.mjs';

test('GPL/AGPL/SSPL are denied unless allow-listed; LGPL and an allowed OR choice pass', () => {
  for (const l of ['GPL-3.0', 'AGPL-3.0-only', 'SSPL-1.0', 'MIT AND GPL-2.0'])
    assert.ok(isDeniedLicense(l), l);
  for (const l of ['LGPL-3.0-or-later', '(MIT OR GPL-3.0)', 'Apache-2.0'])
    assert.ok(!isDeniedLicense(l), l);
  const pkgs = { api: [{ name: 'x', version: '1.0.0', license: 'GPL-3.0' }] };
  assert.equal(checkLicenses(pkgs, {}).findings.length, 1);
  assert.equal(checkLicenses(pkgs, { 'x@1.0.0': 'reviewed' }).findings.length, 0);
});

test('the SBOM is CycloneDX 1.5 with purls and an app → package graph', () => {
  const pkg = { name: '@scope/lib', version: '2.0.0', license: 'MIT' };
  const bom = toCycloneDx({
    version: '0.1.0',
    apps: { api: [pkg], web: [pkg] },
    timestamp: 't',
    serial: 's',
  });
  assert.equal(bom.bomFormat, 'CycloneDX');
  assert.equal(bom.specVersion, '1.5');
  const libs = bom.components.filter((c) => c.type === 'library');
  assert.deepEqual(
    libs.map((c) => [c.purl, c.licenses]),
    [['pkg:npm/%40scope/lib@2.0.0', [{ license: { id: 'MIT' } }]]],
  );
  assert.deepEqual(bom.dependencies.find((d) => d.ref === 'tmanage-web').dependsOn, [libs[0].purl]);
});

test('the repo passes the lockfile policy, and an unreviewed built dependency fails it', () => {
  const inputs = readPolicyInputs();
  assert.deepEqual(checkPolicy(inputs), []);
  const added = { ...inputs, workspaceYaml: `${inputs.workspaceYaml}\n  - evil-postinstall\n` };
  assert.match(checkPolicy(added).join('\n'), /evil-postinstall is not reviewed/);
  assert.match(
    checkPolicy({ ...inputs, bundleNpmrc: 'bin-links=false\n' }).join('\n'),
    /ignore-scripts/,
  );
  assert.ok(
    satisfiesRange('22.22.0', '>=22.12.0 <23') && !satisfiesRange('23.0.0', '>=22.12.0 <23'),
  );
});
