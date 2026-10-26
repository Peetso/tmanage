/**
 * The docked AI side panel (Figma section 400:5399) for the TManage desktop companion.
 *
 * The web app draws the panel's chrome and reports where its website area is; this module shows
 * the assistant's own website there, in a `WebContentsView` of its own:
 *
 *   - its own persistent session partition per assistant, so no TManage cookie or storage is
 *     shared with it and the person stays signed in to their own account between launches;
 *   - no preload, sandboxed, context-isolated: TManage never injects a script into the
 *     assistant's page and never reads it;
 *   - navigation limited to that assistant's domains by `classifyAssistantNavigation`; anything
 *     else goes to the system browser or nowhere.
 */
import { BrowserWindow, WebContentsView, screen, session, shell } from 'electron';
import type { WebContents } from 'electron';
import type { AiPanelBounds } from './ipc';
import { assistantSite, classifyAssistantNavigation } from './navigation-guard';

const POP_OUT_WIDTH = 480;
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);
const hardenedSessions = new Set<string>();

function partitionFor(siteKey: string): string {
  return `persist:tmanage-ai-${siteKey}`;
}

function webPreferencesFor(siteKey: string): Electron.WebPreferences {
  return {
    partition: partitionFor(siteKey),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    spellcheck: false,
  };
}

/** Deny every permission prompt the assistant's page raises except copying to the clipboard. */
function hardenSession(siteKey: string): void {
  const partition = partitionFor(siteKey);
  if (hardenedSessions.has(partition)) return;
  hardenedSessions.add(partition);
  const assistantSession = session.fromPartition(partition);
  assistantSession.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(ALLOWED_PERMISSIONS.has(permission)),
  );
  assistantSession.setPermissionCheckHandler((_contents, permission) =>
    ALLOWED_PERMISSIONS.has(permission),
  );
}

/** Keep the assistant's contents (and any sign-in pop-up it opens) on its own domains. */
function hardenContents(contents: WebContents, siteKey: string): void {
  contents.setWindowOpenHandler(({ url }) => {
    const decision = classifyAssistantNavigation(url, siteKey);
    if (decision === 'allow') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { webPreferences: webPreferencesFor(siteKey) },
      };
    }
    if (decision === 'external') void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('did-create-window', (child) => hardenContents(child.webContents, siteKey));

  const guard = (event: Electron.Event, url: string): void => {
    const decision = classifyAssistantNavigation(url, siteKey);
    if (decision === 'allow') return;
    event.preventDefault();
    if (decision === 'external') void shell.openExternal(url);
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

export interface AiPanelController {
  open(siteKey: string, bounds: AiPanelBounds | undefined): boolean;
  setBounds(bounds: AiPanelBounds | undefined): void;
  popOut(): boolean;
  close(): void;
}

export function createAiPanelController(getWindow: () => BrowserWindow | null): AiPanelController {
  let view: WebContentsView | null = null;
  let currentKey: string | null = null;

  function place(bounds: AiPanelBounds | undefined): void {
    const win = getWindow();
    if (!view || !win) return;
    // The numbers come from the page: anything not a finite number counts as zero.
    const n = (value: unknown): number => (Number.isFinite(Number(value)) ? Number(value) : 0);
    const zoom = win.webContents.getZoomFactor();
    const [contentWidth = 0, contentHeight = 0] = win.getContentSize();
    const x = Math.max(0, Math.round(n(bounds?.x) * zoom));
    const y = Math.max(0, Math.round(n(bounds?.y) * zoom));
    const width = Math.max(0, Math.min(Math.round(n(bounds?.width) * zoom), contentWidth - x));
    const height = Math.max(0, Math.min(Math.round(n(bounds?.height) * zoom), contentHeight - y));
    const visible = bounds?.visible === true && width > 0 && height > 0;
    view.setVisible(visible);
    if (visible) view.setBounds({ x, y, width, height });
  }

  function close(): void {
    const win = getWindow();
    if (view) {
      if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
    view = null;
    currentKey = null;
  }

  function open(siteKey: string, bounds: AiPanelBounds | undefined): boolean {
    const site = assistantSite(siteKey);
    const win = getWindow();
    if (!site || !win) return false;
    if (view && currentKey === siteKey) {
      place(bounds);
      return true;
    }
    close();
    hardenSession(siteKey);
    view = new WebContentsView({ webPreferences: webPreferencesFor(siteKey) });
    currentKey = siteKey;
    hardenContents(view.webContents, siteKey);
    win.contentView.addChildView(view);
    place(bounds);
    void view.webContents.loadURL(site.home);
    return true;
  }

  function popOut(): boolean {
    const win = getWindow();
    if (!view || !win || !currentKey) return false;
    const siteKey = currentKey;
    const shown = view.webContents.getURL();
    const site = assistantSite(siteKey);
    if (!site) return false;
    const url = classifyAssistantNavigation(shown, siteKey) === 'allow' ? shown : site.home;

    const main = win.getBounds();
    const area = screen.getDisplayMatching(main).workArea;
    const width = Math.min(POP_OUT_WIDTH, area.width);
    const beside = main.x + main.width;
    const x = beside + width <= area.x + area.width ? beside : area.x + area.width - width;
    hardenSession(siteKey);
    const popped = new BrowserWindow({
      x,
      y: main.y,
      width,
      height: main.height,
      title: win.getTitle(),
      autoHideMenuBar: true,
      webPreferences: webPreferencesFor(siteKey),
    });
    hardenContents(popped.webContents, siteKey);
    void popped.loadURL(url);
    close();
    return true;
  }

  return {
    open,
    setBounds: place,
    popOut,
    close,
  };
}
