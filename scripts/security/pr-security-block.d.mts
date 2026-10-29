/** Types for scripts/security/pr-security-block.mjs, the 56-15 pull-request block check. */

export const SECURITY_LINES: readonly string[];

/** The block lines that are missing or unanswered; empty when the block is complete. */
export function missingSecurityLines(body: string | undefined): string[];
