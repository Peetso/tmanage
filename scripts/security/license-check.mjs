#!/usr/bin/env node
/**
 * 56-14 — licence policy for every shipped app's production dependencies.
 *
 * `node scripts/security/license-check.mjs` fails when a package is licensed only under GPL,
 * AGPL or SSPL (strong copyleft / service-source licences TManage cannot ship) and is not
 * reviewed in `docs/security/license-allowlist.json`. LGPL is allowed (dynamic linking), and an
 * `OR` expression passes when any alternative is allowed. A package with no declared licence is
 * reported as a warning so someone looks, but does not fail the gate.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO, SBOM_APPS, listProdPackages } from './sbom.mjs';

export const ALLOWLIST_FILE = 'docs/security/license-allowlist.json';

/** GPL and AGPL of any version, and SSPL. `\b` keeps LGPL out (no boundary inside "LGPL"). */
const DENIED_ID = /\b(?:A?GPL|SSPL)\b/i;

/** Whether an SPDX expression leaves no allowed choice. */
export function isDeniedLicense(expression) {
  const alternatives = String(expression ?? '')
    .replace(/[()]/g, ' ')
    .split(/\s+OR\s+/i);
  return alternatives.every((alt) => alt.split(/\s+AND\s+/i).some((id) => DENIED_ID.test(id)));
}

/**
 * `packagesByApp`: app → `[{ name, version, license }]`. `allowlist`: `{ "name" | "name@version":
 * reason }`. Returns `{ findings, warnings }` as printable lines.
 */
export function checkLicenses(packagesByApp, allowlist) {
  const findings = new Set();
  const warnings = new Set();
  for (const [app, packages] of Object.entries(packagesByApp)) {
    for (const { name, version, license } of packages) {
      const id = `${name}@${version}`;
      if (!license || /^unknown$/i.test(license)) {
        warnings.add(`${app}: ${id} declares no licence`);
      } else if (isDeniedLicense(license) && !(id in allowlist) && !(name in allowlist)) {
        findings.add(`${app}: ${id} is ${license} — denied unless reviewed in ${ALLOWLIST_FILE}`);
      }
    }
  }
  return { findings: [...findings], warnings: [...warnings] };
}

export function readAllowlist(repo = REPO) {
  return JSON.parse(readFileSync(join(repo, ALLOWLIST_FILE), 'utf8')).packages ?? {};
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const byApp = Object.fromEntries(SBOM_APPS.map((app) => [app, listProdPackages(app)]));
  const { findings, warnings } = checkLicenses(byApp, readAllowlist());
  for (const w of warnings) console.warn(`license check (warning): ${w}`);
  if (findings.length > 0) {
    console.error(`license check: ${findings.length} denied licence(s)`);
    for (const f of findings) console.error(`  ${f}`);
    process.exit(1);
  }
  const total = Object.values(byApp).reduce((n, list) => n + list.length, 0);
  console.warn(
    `license check: clean (${total} production packages across ${SBOM_APPS.length} apps)`,
  );
}
