/**
 * System tray for the desktop companion (module 22: "tray icon with Open/Quit").
 */
import path from 'node:path';
import { Menu, Tray, nativeImage, app } from 'electron';

export interface TrayCallbacks {
  /** Bring the main window forward (and recreate/show it if hidden). */
  readonly onOpen: () => void;
  /** Quit the whole application. */
  readonly onQuit: () => void;
}

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

  const menu = Menu.buildFromTemplate([
    { label: 'Open TManage', click: () => callbacks.onOpen() },
    { type: 'separator' },
    { label: 'Quit', click: () => callbacks.onQuit() },
  ]);
  tray.setContextMenu(menu);

  // Left-click (Windows/Linux) opens the window; macOS shows the menu by convention.
  tray.on('click', () => callbacks.onOpen());

  return tray;
}
