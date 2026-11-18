/** The namespaces some file reachable from the public website names. */
export function reachedNamespaces(namespaces: readonly string[]): Set<string>;
/** The `app` catalog part: every namespace of `en` the website does not reach, sorted. */
export function appNamespaces(en: Readonly<Record<string, string>>): string[];
/** The generated `catalog-app-namespaces.ts` module for `namespaces`. */
export function renderModule(namespaces: readonly string[]): string;
