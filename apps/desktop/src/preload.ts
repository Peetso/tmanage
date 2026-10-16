/**
 * Preload bridge for the TManage desktop companion.
 *
 * Runs with `contextIsolation: true` and `sandbox: true`, so this is the *only* seam
 * between the hosted web app and the native shell. It exposes a deliberately tiny,
 * allowlisted surface (03-TECHNICAL-ARCHITECTURE §"Phase 1": capabilities are
 * allowlisted, no generic shell access): a native-notification bridge and the app
 * version. Nothing here hands the renderer a Node primitive, `ipcRenderer`, or any
 * ability beyond these two calls.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type NotifyRequest, type NotifyResult } from './ipc';

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

contextBridge.exposeInMainWorld('tmanageDesktop', api);

export type TManageDesktopBridge = typeof api;
