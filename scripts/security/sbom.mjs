#!/usr/bin/env node
/**
 * 56-14 — software bill of materials, one CycloneDX 1.5 JSON per release.
 *
 * `node scripts/security/sbom.mjs [--out <dir>]` writes `docs/security/sbom/<version>.cdx.json`
 * (version from the root package.json). The release step runs it; no runtime principal does.
 *
 * Source: `pnpm licenses list --json --prod` per shipped app, which reads the installed tree that
 * the frozen pnpm-lock.yaml produced — offline, no extra dependency (`@cyclonedx/cyclonedx-npm`
 * cannot be added without a network install). Each shipped app is an `application` component;
 * every third-party package is one `library` component (deduplicated by purl), and the
 * `dependencies` graph says which app pulls in which package.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

/** The apps a release ships (apps/<name>, package `@tmanage/<name>`). */
export const SBOM_APPS = Object.freeze(['web', 'api', 'worker', 'server', 'desktop', 'mcp-server']);

const byNameVersion = (a, b) =>
  a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name);

/** `pnpm licenses list --json` output → `[{ name, version, license }]`, one row per version. */
export function flattenLicenses(report) {
  const rows = [];
  for (const [license, pkgs] of Object.entries(report)) {
    for (const pkg of pkgs) {
      for (const version of pkg.versions ?? []) {
        rows.push({ name: pkg.name, version, license: pkg.license ?? license });
      }
    }
  }
  return rows.sort(byNameVersion);
}

/** The production packages one app installs. An app with none prints text, not JSON. */
export function listProdPackages(app, repo = REPO) {
  const raw = execFileSync(
    'pnpm',
    ['--filter', `@tmanage/${app}`, 'licenses', 'list', '--json', '--prod'],
    {
      cwd: repo,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      maxBuffer: 64 * 1024 * 1024,
    },
  ).trim();
  return raw.startsWith('{') ? flattenLicenses(JSON.parse(raw)) : [];
}

/** Package URL for an npm package (`@scope` is percent-encoded per the purl spec). */
export function npmPurl(name, version) {
  const encoded = name.startsWith('@') ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encoded}@${version}`;
}

/** A single SPDX id becomes `license.id`; anything compound stays an `expression`. */
function cdxLicenses(license) {
  if (!license || /^unknown$/i.test(license)) return undefined;
  return /^[A-Za-z0-9.+-]+$/.test(license)
    ? [{ license: { id: license } }]
    : [{ expression: license }];
}

/**
 * Build the CycloneDX document. `apps` maps app name → its production packages.
 * `timestamp` and `serial` are injectable so the shape can be tested deterministically.
 */
export function toCycloneDx({
  version,
  apps,
  timestamp = new Date().toISOString(),
  serial = randomUUID(),
}) {
  const libraries = new Map();
  const dependencies = [];
  const appRefs = [];
  for (const [app, packages] of Object.entries(apps)) {
    const ref = `tmanage-${app}`;
    appRefs.push(ref);
    const dependsOn = new Set();
    for (const pkg of packages) {
      const purl = npmPurl(pkg.name, pkg.version);
      dependsOn.add(purl);
      if (!libraries.has(purl)) {
        const licenses = cdxLicenses(pkg.license);
        libraries.set(purl, {
          type: 'library',
          'bom-ref': purl,
          name: pkg.name,
          version: pkg.version,
          purl,
          ...(licenses ? { licenses } : {}),
        });
      }
    }
    dependencies.push({ ref, dependsOn: [...dependsOn].sort() });
  }
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${serial}`,
    version: 1,
    metadata: {
      timestamp,
      component: { type: 'application', 'bom-ref': 'tmanage', name: 'tmanage', version },
    },
    components: [
      ...appRefs.map((ref) => ({
        type: 'application',
        'bom-ref': ref,
        name: `@tmanage/${ref.slice('tmanage-'.length)}`,
        version,
      })),
      ...[...libraries.values()].sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref'])),
    ],
    dependencies: [{ ref: 'tmanage', dependsOn: appRefs }, ...dependencies],
  };
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const outFlag = process.argv.indexOf('--out');
  const outDir =
    outFlag > 0 ? resolve(process.argv[outFlag + 1]) : join(REPO, 'docs', 'security', 'sbom');
  const { version } = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  const apps = Object.fromEntries(SBOM_APPS.map((app) => [app, listProdPackages(app)]));
  const bom = toCycloneDx({ version, apps });
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${version}.cdx.json`);
  writeFileSync(file, `${JSON.stringify(bom, null, 2)}\n`);
  console.warn(`sbom: ${bom.components.length} components → ${file}`);
}
