/**
 * Runtime configuration for the TManage desktop companion.
 *
 * The shell "calls the same hosted API and renders the shared product UI"
 * (03-TECHNICAL-ARCHITECTURE §"Phase 1"), so the only thing it needs told is *which*
 * deployment to point at. That is `TMANAGE_URL`; it defaults to the local web dev
 * server (`pnpm --filter @tmanage/web dev` listens on :3000).
 */

export const DEFAULT_TMANAGE_URL = 'http://localhost:3000';

export interface DesktopConfig {
  /** Full start URL the window first loads. */
  readonly startUrl: string;
  /** Canonical origin used by the navigation guard to decide in-app vs external. */
  readonly appOrigin: string;
}

/**
 * Resolve configuration from an environment bag (defaults to `process.env`).
 *
 * An invalid or non-http(s) `TMANAGE_URL` falls back to the default rather than
 * throwing: a wrapper that refuses to start because of a typo in an env var is worse
 * than one that opens the local app and surfaces the mistake on screen.
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): DesktopConfig {
  const raw = env['TMANAGE_URL']?.trim();
  const startUrl = raw && isHttpUrl(raw) ? raw : DEFAULT_TMANAGE_URL;
  return {
    startUrl,
    appOrigin: new URL(startUrl).origin,
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
