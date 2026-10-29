/**
 * The installer's checksum file (`/downloads/TManage-Setup.exe.sha256`), written at deploy time by
 * `deploy/hostinger/build.mjs` in `sha256sum` form (`<hex>  TManage-Setup.exe`) and served by the
 * one-process server, never by Next.js.
 */
export const DESKTOP_INSTALLER_SHA256_HREF = '/downloads/TManage-Setup.exe.sha256';

/** The 64-character lower-case SHA-256 in a `sha256sum` line, or `undefined` for anything else. */
export function parseSha256(text: string): string | undefined {
  const first = text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return /^[0-9a-f]{64}$/.test(first) ? first : undefined;
}
