import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `pnpm verify` must be honest about what it does and does not run (test-honesty sweep I1).
 *
 * `verify` runs the fast gates and the fast `pnpm test`, which for `@tmanage/api` is the
 * `unit` project only — the database corpus (`test:db`), the end-to-end suite (`test:e2e`)
 * and the visual-regression suite (`test:vr`) are separate, slower gates. That separation is
 * deliberate and correct. What is not acceptable is for a green `verify` to *read* as
 * "everything checked" while those three gates never ran and nothing said so.
 *
 * So this guard fixes the shape of the two scripts:
 *
 *   - `verify` ends by printing `verify:gaps`, the closing line that names the three gates it
 *     skipped — and `verify` must NOT quietly grow a 30-minute `test:db`/`test:e2e`/`test:vr`
 *     step, which would make it slow rather than honest.
 *   - `verify:full` exists and chains all three, so there is a documented one-command full gate.
 *   - `scripts/verify-gaps.mjs` actually names all three gates, so the disclosure cannot rot
 *     into a line that discloses nothing.
 *
 * It reads the real root `package.json` and the real script, so deleting the disclosure or the
 * full gate turns this red.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const rootPackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const scripts = rootPackage.scripts;
const SLOW_GATES = ['test:db', 'test:e2e', 'test:vr'] as const;

describe('the verify gate is honest about what it skips (I1)', () => {
  it('verify runs its own disclosure line as its last step', () => {
    // `toContain` would be satisfied by a `verify:gaps` buried in the middle of the chain,
    // where a later failing step hides the disclosure behind a red build — the closing line
    // has to actually close. So this asserts the position the title claims, not presence.
    expect(scripts['verify']?.trim()).toMatch(/&&\s*pnpm verify:gaps$/);
  });

  /**
   * D10 (the vacuous `contracts:validate` gate) is fixed on master by the x12 slice (b6be028):
   * `verify` runs `pnpm contracts:check`, a real `scripts/contracts-check.mjs` shape check, and
   * `contracts:validate` is gone. Nothing anywhere pinned that, so a merge resolution that kept
   * this branch's older `contracts:validate` line would reopen D10 in silence. This is the pin.
   */
  it('verify still runs the real contract gate (D10 must not be reopened by a merge)', () => {
    expect(scripts['verify']).toContain('pnpm contracts:check');
  });

  it('verify does not silently grow a slow gate into itself', () => {
    // The value here is speed *and* honesty: verify stays fast, and the slow gates live in
    // verify:full where they are named, not hidden inside a step called "verify".
    for (const gate of SLOW_GATES) {
      expect(scripts['verify']).not.toContain(gate);
    }
  });

  it('verify:full chains every gate verify skipped', () => {
    const full = scripts['verify:full'] ?? '';
    expect(full).toContain('pnpm verify');
    for (const gate of SLOW_GATES) {
      expect(full).toContain(gate);
    }
  });

  it('the disclosure line names all three skipped gates', () => {
    const disclosure = readFileSync(join(repoRoot, 'scripts', 'verify-gaps.mjs'), 'utf8');
    for (const gate of SLOW_GATES) {
      expect(disclosure).toContain(gate);
    }
  });
});

// I2 / D10 (the vacuous `contracts:validate` gate) is fixed on master by the x12 slice
// (b6be028): `verify` now runs `pnpm contracts:check` (a real `scripts/contracts-check.mjs`
// shape check), and `contracts:validate` is gone. This slice does not duplicate that fix — it
// only pins it above, so the `package.json` merge cannot quietly resolve it away.
