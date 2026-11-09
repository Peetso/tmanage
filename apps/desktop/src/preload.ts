/**
 * Preload bridge for the TManage desktop companion.
 *
 * Runs with `contextIsolation: true` and `sandbox: true`, so this is the *only* seam
 * between the hosted web app and the native shell. It exposes a deliberately tiny,
 * allowlisted surface (03-TECHNICAL-ARCHITECTURE §"Phase 1": capabilities are
 * allowlisted, no generic shell access): a native-notification bridge, the app
 * version, the AI side panel and the computer's idle state for automatic time tracking. Nothing here hands the renderer a Node primitive,
 * `ipcRenderer`, or any ability beyond these calls. A sandboxed preload may `require` only
 * `electron`, so `pnpm build` bundles this file and its local imports into `dist/preload.js`.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { isActivityEvent } from './activity';
import {
  IPC,
  type ActivityEvent,
  type ActivitySample,
  type AiPanelBounds,
  type AiPanelOpenRequest,
  type NotifyRequest,
  type NotifyResult,
} from './ipc';

const api = {
  /** Resolve the installed desktop app version (e.g. "0.1.0"). */
  getAppVersion: (): Promise<string> => ipcRenderer.invoke(IPC.getVersion) as Promise<string>,

  /**
   * Raise a native OS notification through the shell. Prefer this over the web
   * Notification API when running in the desktop app for correct app identity and
   * tray/focus behaviour. Resolves `{ shown: false }` if the OS cannot display it.
   */
  notify: (request: NotifyRequest): Promise<NotifyResult> =>
    ipcRenderer.invoke(IPC.notify, sanitiseNotify(request)) as Promise<NotifyResult>,

  /**
   * The docked AI side panel (Figma 400:5399). The page names an assistant by key and reports
   * where its website area is; the shell owns the view, which the page cannot script or read.
   */
  aiPanel: {
    open: (request: AiPanelOpenRequest): Promise<boolean> =>
      ipcRenderer.invoke(IPC.aiPanelOpen, {
        site: String(request?.site ?? ''),
        bounds: sanitiseBounds(request?.bounds),
      }) as Promise<boolean>,
    setBounds: (bounds: AiPanelBounds): Promise<void> =>
      ipcRenderer.invoke(IPC.aiPanelBounds, sanitiseBounds(bounds)) as Promise<void>,
    popOut: (): Promise<boolean> => ipcRenderer.invoke(IPC.aiPanelPopOut) as Promise<boolean>,
    close: (): Promise<void> => ipcRenderer.invoke(IPC.aiPanelClose) as Promise<void>,
  },

  /**
   * Automatic time tracking: the whole-computer idle signal. `sample()` answers how many seconds
   * since the last keyboard or mouse input anywhere on the computer, and whether the screen is
   * locked; `onEvent` reports lock, unlock, sleep and wake. Nothing else (no app or window names,
   * URLs, keystrokes or screenshots) is available through this bridge.
   */
  activity: {
    sample: async (): Promise<ActivitySample | null> => {
      const raw = (await ipcRenderer.invoke(IPC.activitySample)) as ActivitySample | null;
      if (raw === null || typeof raw !== 'object') return null;
      return { idleSeconds: Number(raw.idleSeconds) || 0, locked: raw.locked === true };
    },
    onEvent: (listener: (event: ActivityEvent) => void): (() => void) => {
      const handler = (_event: unknown, value: unknown): void => {
        if (isActivityEvent(value)) listener(value);
      };
      ipcRenderer.on(IPC.activityEvent, handler);
      return () => {
        ipcRenderer.removeListener(IPC.activityEvent, handler);
      };
    },
  },

  /** Lets the web app detect it is running inside the native companion. */
  readonly: true as const,
};

function sanitiseNotify(request: NotifyRequest): NotifyRequest {
  // Never forward arbitrary renderer objects across the boundary; copy only known fields.
  const out: { title: string; body?: string; silent?: boolean } = {
    title: String(request?.title ?? ''),
  };
  if (request?.body !== undefined) out.body = String(request.body);
  if (request?.silent !== undefined) out.silent = Boolean(request.silent);
  return out;
}

function sanitiseBounds(bounds: AiPanelBounds | undefined): AiPanelBounds {
  const n = (value: unknown): number => (Number.isFinite(Number(value)) ? Number(value) : 0);
  return {
    x: n(bounds?.x),
    y: n(bounds?.y),
    width: n(bounds?.width),
    height: n(bounds?.height),
    visible: Boolean(bounds?.visible),
  };
}

contextBridge.exposeInMainWorld('tmanageDesktop', api);

export type TManageDesktopBridge = typeof api;
