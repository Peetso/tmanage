/**
 * Types for scripts/security/secrets-census.mjs, the 56-15 secrets census gate.
 * See the module header for what it checks and why.
 */

export const CREDENTIAL_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[];
export const FIXTURE_ALLOWLIST: ReadonlyMap<string, string>;
export const SECRET_NAME: RegExp;
export const ENV_SCHEMA_FILE: string;

export function documentedNames(envExample: string): Set<string>;
export function credentialFindings(path: string, text: string): string[];
export function undocumentedSecretReads(
  path: string,
  text: string,
  documented: ReadonlySet<string>,
): string[];
export function undocumentedSchemaSecrets(
  path: string,
  text: string,
  documented: ReadonlySet<string>,
): string[];
export function runCensus(repoRoot: string): { scanned: number; findings: string[] };
