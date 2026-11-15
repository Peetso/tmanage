/**
 * Item 16 — the desktop app's "Start with the computer" bridge (apps/desktop/src/preload.ts), when
 * the page runs inside the TManage desktop app. Absent in a browser.
 */
export interface DesktopStartupState {
  readonly openAtLogin: boolean;
  /** True once the person chose; the workspace default then changes nothing. */
  readonly chosen: boolean;
}

export interface DesktopStartupBridge {
  get(): Promise<DesktopStartupState>;
  set(openAtLogin: boolean): Promise<DesktopStartupState>;
  applyDefault(openAtLogin: boolean): Promise<DesktopStartupState>;
}

export function desktopStartup(): DesktopStartupBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (
    window as unknown as { tmanageDesktop?: { startup?: Partial<DesktopStartupBridge> } }
  ).tmanageDesktop?.startup;
  if (
    bridge === undefined ||
    typeof bridge.get !== 'function' ||
    typeof bridge.set !== 'function' ||
    typeof bridge.applyDefault !== 'function'
  ) {
    return null;
  }
  return bridge as DesktopStartupBridge;
}
