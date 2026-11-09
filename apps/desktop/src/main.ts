/**
 * Main process for the TManage desktop companion (module 22, "Desktop companion").
 *
 * A thin, allowlisted Electron shell around the existing hosted web app. It owns no
 * product logic: it opens a single BrowserWindow on the configured TManage origin,
 * keeps navigation on that origin, sends foreign links to the system browser, bridges
 * native notifications, provides a tray and a `tmanage://` deep-link route, and
 * remembers the window's size and position. Security posture (contextIsolation,
 * sandbox, no nodeIntegration) follows Electron's hardening guidance and the pack's
 * "capabilities are allowlisted; no generic shell execution or broad file access"
 * requirement (03-TECHNICAL-ARCHITECTURE §"Phase 1").
 */
import path from 'node:path';
import { app, BrowserWindow, Notification, ipcMain, powerMonitor, shell } from 'electron';
import type { Tray } from 'electron';
import { resolveConfig } from './config';
import { classifyNavigation, isInAppNavigation, shouldOpenExternally } from './navigation-guard';
import { DEEP_LINK_PROTOCOL, findDeepLinkArg, resolveDeepLink } from './deep-link';
import { createTray } from './tray';
import { loadWindowState, saveWindowState, type WindowState } from './window-state';
import {
  IPC,
  type AiPanelBounds,
  type AiPanelOpenRequest,
  type NotifyRequest,
  type NotifyResult,
} from './ipc';
import { createAiPanelController } from './ai-panel';
import { POWER_MONITOR_EVENTS, toActivityEvent, toActivitySample } from './activity';

const config = resolveConfig();
const assetsDir = path.join(__dirname, '..', 'assets');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
const aiPanel = createAiPanelController(() => mainWindow);

/* ── Single-instance lock ──────────────────────────────────────────────────── */
// A companion app is a singleton: a second launch (or an OS deep-link hand-off) must
// surface the running window, not spawn a rival process.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  registerProtocol();

  app.on('second-instance', (_event, argv) => {
    focusMainWindow();
    const deepLink = findDeepLinkArg(argv);
    if (deepLink) navigateToDeepLink(deepLink);
  });

  // macOS delivers deep links as an event rather than an argv entry.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (app.isReady()) navigateToDeepLink(url);
    else pendingDeepLink = url;
  });

  app
    .whenReady()
    .then(onReady)
    .catch((err: unknown) => {
      console.error('[tmanage-desktop] failed to start', err);
      app.quit();
    });

  app.on('window-all-closed', () => {
    // The tray keeps the app alive on Windows/Linux; only an explicit Quit exits.
    if (process.platform !== 'darwin' && isQuitting) app.quit();
  });

  app.on('activate', () => {
    if (!mainWindow) createMainWindow();
    else focusMainWindow();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    // Release the tray icon so it does not linger after the process exits.
    tray?.destroy();
    tray = null;
  });
}

/** A deep link that arrived before the app finished starting. */
let pendingDeepLink: string | null = findDeepLinkArg(process.argv);

function onReady(): void {
  registerIpcHandlers();
  createMainWindow();
  tray = createTray(assetsDir, {
    onOpen: focusMainWindow,
    onQuit: () => {
      isQuitting = true;
      app.quit();
    },
  });
  if (pendingDeepLink) {
    navigateToDeepLink(pendingDeepLink);
    pendingDeepLink = null;
  }
}

/* ── Window ────────────────────────────────────────────────────────────────── */
function createMainWindow(): void {
  const state = loadWindowState(app.getPath('userData'));

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#090a09', // brand ink, matches the PWA splash
    title: app.getName(),
    icon: path.join(assetsDir, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      // Automatic time tracking keeps sampling while the window is hidden in the tray.
      backgroundThrottling: false,
    },
  });

  if (state.maximized) mainWindow.maximize();

  hardenWebContents(mainWindow);
  persistWindowState(mainWindow);

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.on('close', (event) => {
    // Hide to tray instead of quitting, unless the user chose Quit.
    if (!isQuitting && process.platform !== 'darwin') {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    aiPanel.close();
    mainWindow = null;
  });

  // A full page load in TManage drops the panel chrome, so the docked assistant goes with it.
  mainWindow.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) aiPanel.close();
  });

  void mainWindow.loadURL(config.startUrl);
}

/**
 * Apply the navigation / external-link allowlist to a window's web contents, and to any
 * child contents it tries to spawn. Same-origin navigations stay in the window; safe
 * outward links open in the system browser; everything else is dropped.
 */
function hardenWebContents(win: BrowserWindow): void {
  const { webContents } = win;

  webContents.setWindowOpenHandler(({ url }) => {
    if (shouldOpenExternally(url, config.appOrigin)) {
      void shell.openExternal(url);
    }
    // Never let the web app spawn its own BrowserWindow; everything is routed above.
    return { action: 'deny' };
  });

  const guard = (event: Electron.Event, url: string): void => {
    if (isInAppNavigation(url, config.appOrigin)) return;
    event.preventDefault();
    if (shouldOpenExternally(url, config.appOrigin)) void shell.openExternal(url);
  };
  webContents.on('will-navigate', guard);
  webContents.on('will-redirect', guard);

  // Block attachment of extra web contents (e.g. webviews) outright.
  webContents.on('will-attach-webview', (event) => event.preventDefault());
}

function persistWindowState(win: BrowserWindow): void {
  const capture = (): void => {
    if (!mainWindow || win.isDestroyed()) return;
    const bounds = win.getNormalBounds();
    const next: WindowState = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: win.isMaximized(),
    };
    saveWindowState(app.getPath('userData'), next);
  };
  win.on('resize', capture);
  win.on('move', capture);
  win.on('close', capture);
}

function focusMainWindow(): void {
  if (!mainWindow) {
    createMainWindow();
    return;
  }
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

/* ── Deep links ────────────────────────────────────────────────────────────── */
function navigateToDeepLink(deepLink: string): void {
  const target = resolveDeepLink(deepLink, config.startUrl);
  if (!target) {
    console.warn('[tmanage-desktop] ignored unroutable deep link:', deepLink);
    return;
  }
  focusMainWindow();
  void mainWindow?.loadURL(target);
}

function registerProtocol(): void {
  if (process.defaultApp && process.argv.length >= 2) {
    // Running unpackaged (e.g. `electron .`): point the OS handler at this script.
    app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL, process.execPath, [
      path.resolve(process.argv[1] ?? '.'),
    ]);
  } else {
    app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL);
  }
}

/* ── IPC: the entire native surface exposed to the renderer ────────────────── */
function registerIpcHandlers(): void {
  ipcMain.handle(IPC.getVersion, () => app.getVersion());

  ipcMain.handle(IPC.notify, (_event, request: NotifyRequest): NotifyResult => {
    if (!Notification.isSupported()) return { shown: false };
    const notification = new Notification({
      title: String(request?.title ?? ''),
      ...(request?.body !== undefined ? { body: String(request.body) } : {}),
      ...(request?.silent !== undefined ? { silent: Boolean(request.silent) } : {}),
    });
    notification.on('click', focusMainWindow);
    notification.show();
    return { shown: true };
  });

  // The AI side panel answers the TManage page only — never the assistant's own view.
  const fromApp = (event: Electron.IpcMainInvokeEvent): boolean =>
    mainWindow !== null && event.sender === mainWindow.webContents;
  ipcMain.handle(IPC.aiPanelOpen, (event, request: AiPanelOpenRequest): boolean =>
    fromApp(event) ? aiPanel.open(String(request?.site ?? ''), request?.bounds) : false,
  );
  ipcMain.handle(IPC.aiPanelBounds, (event, bounds: AiPanelBounds): void => {
    if (fromApp(event)) aiPanel.setBounds(bounds);
  });
  ipcMain.handle(IPC.aiPanelPopOut, (event): boolean =>
    fromApp(event) ? aiPanel.popOut() : false,
  );
  ipcMain.handle(IPC.aiPanelClose, (event): void => {
    if (fromApp(event)) aiPanel.close();
  });

  // Automatic time tracking: the whole-computer idle state, to the TManage page only. Seconds
  // since the last input and whether the screen is locked — nothing about what was typed or which
  // app or site was open.
  ipcMain.handle(IPC.activitySample, (event) => {
    if (!fromApp(event)) return null;
    // The threshold only decides `idle` vs `active`; the renderer applies its own from the seconds.
    return toActivitySample(powerMonitor.getSystemIdleTime(), powerMonitor.getSystemIdleState(60));
  });
  for (const name of POWER_MONITOR_EVENTS) {
    const activityEvent = toActivityEvent(name);
    if (activityEvent === null) continue;
    powerMonitor.on(name as 'lock-screen', () => {
      mainWindow?.webContents.send(IPC.activityEvent, activityEvent);
    });
  }
}

// Re-exported for tooling/tests that want the resolved policy without booting Electron.
export { classifyNavigation };
