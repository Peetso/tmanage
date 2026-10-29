#!/usr/bin/env node
/**
 * 56-15 — secrets census. A Secure SDLC gate, run in CI's `security` job beside gitleaks.
 *
 * gitleaks (CI only, Docker) finds credential *shapes* across history. This census is the
 * offline, no-Docker half that a developer can run before pushing (`node
 * scripts/security/secrets-census.mjs`), and it checks two things gitleaks cannot:
 *
 *   1. **No live credential in a tracked file.** Private-key blocks and the token shapes of
 *      the providers TManage talks to (AWS, Google, GitHub, Slack, Stripe live keys, OpenAI /
 *      Anthropic keys). Test fixtures that need a key shape generate one at run time.
 *   2. **Every secret comes from the environment, and every one is documented.** A source read
 *      of a secret-named variable (`process.env.X_SECRET`, `…_KEY`, `…_TOKEN`, `…_PASSWORD`)
 *      must name a variable listed in `.env.example`, so no secret is wired in that an operator
 *      cannot discover — and the feature that reads it is expected to degrade when it is unset.
 *
 * Exit 0 with a one-line summary, or exit 1 listing every finding as `path:line  reason`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Credential shapes that must never be committed. Each is specific enough to have no common false positive. */
export const CREDENTIAL_PATTERNS = [
  {
    name: 'private key block',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/,
  },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    name: 'GitHub token',
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/,
  },
  { name: 'Slack token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'Stripe live key', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/ },
  {
    name: 'Anthropic / OpenAI key',
    re: /\bsk-(?:ant-[A-Za-z0-9_-]{20,}|proj-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{48})\b/,
  },
];

/**
 * Reviewed test fixtures that carry a credential *shape* and no credential. Keyed
 * `path|pattern name`, so the exception covers that one shape in that one file and nothing else.
 * Adding an entry is a review decision; prefer generating the shape at run time.
 */
export const FIXTURE_ALLOWLIST = new Map([
  [
    'packages/mail/src/smtp-mailer.test.ts|private key block',
    'self-signed CN=localhost TLS fixture for the SMTP dialog test',
  ],
  [
    'apps/api/src/modules/automations/directory.controller.test.ts|Slack token',
    "the literal 'xoxb-should-never-persist', proving secret-shaped config is refused",
  ],
]);

/** A variable whose value is a secret by its name. */
export const SECRET_NAME =
  /(?:SECRET|PASSWORD|PASSPHRASE|TOKEN|PRIVATE|_KEY|_KEYS|KEYRING|_PEPPER)(?:_|$)/;

/** Reads of a named environment variable: `process.env.X` and `process.env['X']`. */
const ENV_READ = /process\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\])/g;

/** A key of the zod environment schema: `    NAME: z…` / `    NAME: secret(…)`. */
const SCHEMA_KEY = /^\s+([A-Z][A-Z0-9_]*)\s*:/;

/** The environment schema every deployed process boots through (packages/config). */
export const ENV_SCHEMA_FILE = 'packages/config/src/env.ts';

/** Files that are not source text, or are generated, and are skipped by the credential scan. */
const SKIP_FILE =
  /(?:^|\/)(?:pnpm-lock\.yaml|graphify-out\/|docs\/planning\/|docs\/design\/source\/)|\.(?:png|jpe?g|gif|webp|ico|svg|pdf|woff2?|ttf|otf|mp4|mp3|wav|zip|tgz|gz|wasm|node)$/i;

/** Source files whose environment reads are checked (tests may set variables of their own). */
const SOURCE_FILE = /^(?:apps|packages)\/[^/]+\/src\/.+\.(?:ts|tsx|mts|js|mjs)$/;
const TEST_FILE = /\.(?:test|spec|db\.test)\.[cm]?[jt]sx?$/;

/** Variable names declared in a `.env.example` (commented-out declarations count). */
export function documentedNames(envExample) {
  const names = new Set();
  for (const line of envExample.split(/\r?\n/)) {
    const m = /^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

/** Credential findings in one file's text. */
export function credentialFindings(path, text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const { name, re } of CREDENTIAL_PATTERNS) {
      if (re.test(line) && !FIXTURE_ALLOWLIST.has(`${path}|${name}`))
        out.push(`${path}:${i + 1}  ${name}`);
    }
  });
  return out;
}

/** Secret-named environment reads in one source file that `.env.example` does not document. */
export function undocumentedSecretReads(path, text, documented) {
  const out = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(ENV_READ)) {
      const name = m[1] ?? m[2];
      if (SECRET_NAME.test(name) && !documented.has(name)) {
        out.push(
          `${path}:${i + 1}  secret ${name} is read from the environment but not listed in .env.example`,
        );
      }
    }
  });
  return out;
}

/** Secret-named keys of the environment schema that `.env.example` does not document. */
export function undocumentedSchemaSecrets(path, text, documented) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const m = SCHEMA_KEY.exec(line);
    if (m && SECRET_NAME.test(m[1]) && !documented.has(m[1])) {
      out.push(
        `${path}:${i + 1}  secret ${m[1]} is in the environment schema but not listed in .env.example`,
      );
    }
  });
  return out;
}

export function runCensus(repoRoot) {
  const files = execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((f) => f !== '');
  const documented = documentedNames(readFileSync(join(repoRoot, '.env.example'), 'utf8'));
  const findings = [];
  let scanned = 0;
  for (const file of files) {
    if (SKIP_FILE.test(file)) continue;
    let text;
    try {
      text = readFileSync(join(repoRoot, file), 'utf8');
    } catch {
      continue; // deleted in the working tree but still in the index
    }
    if (text.includes('\0')) continue; // binary
    scanned += 1;
    findings.push(...credentialFindings(file, text));
    if (file === ENV_SCHEMA_FILE)
      findings.push(...undocumentedSchemaSecrets(file, text, documented));
    if (SOURCE_FILE.test(file) && !TEST_FILE.test(file)) {
      findings.push(...undocumentedSecretReads(file, text, documented));
    }
  }
  return { scanned, findings };
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
  const { scanned, findings } = runCensus(repoRoot);
  if (findings.length > 0) {
    console.error(`secrets census: ${findings.length} finding(s) in ${scanned} tracked files`);
    for (const f of findings) console.error(`  ${f}`);
    process.exit(1);
  }
  console.warn(`secrets census: clean (${scanned} tracked files)`);
}
