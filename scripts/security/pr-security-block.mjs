#!/usr/bin/env node
/**
 * 56-15 — the pull-request security block check. Run by CI's `security` job on pull requests.
 *
 * The pull request body (PR_BODY, set from the event payload — never interpolated into the
 * shell) must carry the `SECURITY:` block from docs/security/ticket-security-template.md with an
 * answer on each of its seven lines. "none" is an answer; an empty line or the template's
 * `<placeholder>` is not.
 *
 * Exit 0 when the block is complete, 1 listing what is missing.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SECURITY_LINES = [
  'Principals',
  'Tables',
  'Routes',
  'Secrets',
  'Public surface',
  'Abuse case',
  'Tests',
];

/** The lines of the block that are missing or unanswered; empty when the block is complete. */
export function missingSecurityLines(body) {
  const text = (body ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const start = text.search(/^\s*SECURITY:\s*$/m);
  if (start < 0) return ['SECURITY: block'];
  const block = text.slice(start);
  return SECURITY_LINES.filter((label) => {
    const m = new RegExp(`^\\s*[-*]\\s*${label}:[ \\t]*(.*)$`, 'mi').exec(block);
    const answer = m?.[1]?.trim() ?? '';
    return answer === '' || /^<.*>$/.test(answer);
  });
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const missing = missingSecurityLines(process.env.PR_BODY);
  if (missing.length > 0) {
    console.error(
      `::error::The pull request's SECURITY: block is incomplete. Missing or empty: ${missing.join(', ')}. ` +
        'See docs/security/ticket-security-template.md.',
    );
    process.exit(1);
  }
  console.warn('SECURITY: block complete');
}
