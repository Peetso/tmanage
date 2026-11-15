/**
 * System tray for the desktop companion (module 22: "tray icon with Open/Quit"), with the
 * "Start TManage when the computer starts" toggle between them (FIX-2026-11-10, item 16).
 */
import path from 'node:path';
import { Menu, Tray, nativeImage, app } from 'electron';

export interface TrayCallbacks {
  /** Bring the main window forward (and recreate/show it if hidden). */
  readonly onOpen: () => void;
  /** Quit the whole application. */
  readonly onQuit: () => void;
  /** Whether TManage starts with the computer right now; read each time the menu is built. */
  readonly startsAtLogin: () => boolean;
  /** The person ticked or unticked the start-with-the-computer item. */
  readonly onStartsAtLoginChange: (openAtLogin: boolean) => void;
}

export const START_AT_LOGIN_LABEL = 'Start TManage when the computer starts';

/**
 * Create the tray icon and its Open/Quit menu. `assetsDir` holds `tray.png`
 * (and the HiDPI `tray@2x.png`, which Electron picks up automatically).
 */
export function createTray(assetsDir: string, callbacks: TrayCallbacks): Tray {
  let image = nativeImage.createFromPath(path.join(assetsDir, 'tray.png'));
  if (image.isEmpty()) {
    // Never let a missing asset crash startup — an empty image still yields a usable
    // (if invisible) tray slot.
    image = nativeImage.createEmpty();
  }

  const tray = new Tray(image);
  tray.setToolTip(app.getName());

  refreshTrayMenu(tray, callbacks);

  // Left-click (Windows/Linux) opens the window; macOS shows the menu by convention.
  tray.on('click', () => callbacks.onOpen());

  return tray;
}

/** Rebuild the menu so the start-with-the-computer tick matches the current state. */
export function refreshTrayMenu(tray: Tray, callbacks: TrayCallbacks): void {
  const menu = Menu.buildFromTemplate([
    { label: 'Open TManage', click: () => callbacks.onOpen() },
    { type: 'separator' },
    {
      label: START_AT_LOGIN_LABEL,
      type: 'checkbox',
      checked: callbacks.startsAtLogin(),
      click: (item) => callbacks.onStartsAtLoginChange(item.checked),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => callbacks.onQuit() },
  ]);
  tray.setContextMenu(menu);
}
