import { IMPORT_SOURCE_IDS, type ImportSourceId } from './import-sources';

/**
 * 54-29 — the `?import=<tool>` hand-over from a "switch from X" page to the in-app Import page,
 * through sign-up or sign-in and the workspace chooser.
 *
 * The value is only ever an id from {@link IMPORT_SOURCE_IDS} (an allow-list, exact match): any
 * other value is dropped, so the parameter can never carry a path, a host or markup. Every link
 * built here is a same-origin path assembled from that id and an encoded workspace slug — the
 * query never decides where the browser goes, only which tool the Import page has open.
 */

export const IMPORT_PARAM = 'import';

/** The tool id from an untrusted value, or `undefined` when it is not one we import from. */
export function allowedImportTool(value: string | null | undefined): ImportSourceId | undefined {
  return typeof value === 'string' && (IMPORT_SOURCE_IDS as readonly string[]).includes(value)
    ? (value as ImportSourceId)
    : undefined;
}

/** The allowed tool named by a `location.search` string, if any. */
export function importToolFromSearch(search: string): ImportSourceId | undefined {
  try {
    return allowedImportTool(new URLSearchParams(search).get(IMPORT_PARAM));
  } catch {
    return undefined;
  }
}

/** `path` with `?import=<tool>` added when the tool is allowed; `path` unchanged otherwise. */
export function withImportTool(path: string, tool: string | null | undefined): string {
  const allowed = allowedImportTool(tool);
  if (allowed === undefined) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${IMPORT_PARAM}=${allowed}`;
}

/** The in-app Import page of a workspace, with the tool preselected when one is allowed. */
export function importPagePath(organizationSlug: string, tool?: string | null): string {
  return withImportTool(`/${encodeURIComponent(organizationSlug)}/onboarding/import`, tool);
}
