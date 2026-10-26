/**
 * The Windows desktop app download (Figma 409:6602). The installer is a deploy-time artifact:
 * `deploy/hostinger/build.mjs` builds it with electron-builder and the one-process server answers
 * this exact path from its allow-list (apps/server/boot-guards.mjs), never through Next.js — so
 * links to it are plain anchors, never localized with an `/ar` prefix.
 */
export const DESKTOP_INSTALLER_HREF = '/downloads/TManage-Setup.exe';

/** Installer size in whole MiB: ~106.5 million bytes (101.6 MiB), 2026-10-26 builds of 0.1.0. */
export const DESKTOP_INSTALLER_SIZE_MB = 102;

/**
 * Whether to offer the download: never inside the desktop app itself, which announces itself
 * by exposing `window.tmanageDesktop` (apps/desktop/src/preload.ts).
 */
export function offerDesktopDownload(win: object | undefined): boolean {
  if (win === undefined) return true;
  return (win as { tmanageDesktop?: unknown }).tmanageDesktop === undefined;
}
