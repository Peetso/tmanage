import { localeBootScript } from './i18n/locale-boot';
import { trustedTypesBootScript } from './trusted-types-boot';

/**
 * The inline `<head>` scripts of every page, in order: the Trusted Types default policy first (so
 * it guards every sink after it), then the locale/title boot. `app/layout.tsx` renders exactly
 * these strings and `src/proxy.ts` allows exactly their SHA-256 — both call this function, so a
 * hash can never be a stale hand-copied value.
 */
export function bootScripts(development: boolean): readonly string[] {
  return [trustedTypesBootScript(development), localeBootScript()];
}
