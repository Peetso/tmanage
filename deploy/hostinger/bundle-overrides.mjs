// npm ignores the root package.json `pnpm.overrides`, so the Hostinger bundle (installed there with
// `npm install`) would not get the transitive security pins the workspace relies on. This turns
// the pnpm overrides into an npm `overrides` object for the bundle's stage manifest.

/** A bare package name: `name` or `@scope/name` — no `@<range>` selector, no `>` parent chain. */
const PLAIN_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/**
 * The npm `overrides` for the runtime packages named in `runtimeNames`, copied from
 * `rootPkg.pnpm.overrides`. Selector keys (`pkg@>=4 <4.1.5`, `a>b`) are skipped — npm cannot
 * express them — as are dev-only names not in `runtimeNames` and pnpm's `-` (remove) value.
 */
export function npmOverridesFromRoot(rootPkg, runtimeNames = []) {
  const allowed = new Set(runtimeNames);
  const overrides = {};
  for (const [key, value] of Object.entries(rootPkg?.pnpm?.overrides ?? {})) {
    if (!PLAIN_NAME.test(key) || !allowed.has(key)) continue;
    if (typeof value !== 'string' || value === '-') continue;
    overrides[key] = value;
  }
  return overrides;
}
