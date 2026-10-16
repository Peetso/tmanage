/**
 * Shared IPC channel names and payload shapes for the preload bridge.
 *
 * Centralised so the preload (renderer side) and main process cannot drift apart, and
 * so the exposed surface is easy to audit: these three channels are the *entire*
 * capability the web app is granted over the native shell.
 */

export const IPC = {
  /** Renderer -> main: resolve the installed desktop app version. */
  getVersion: 'tmanage:get-version',
  /** Renderer -> main: raise a native OS notification. */
  notify: 'tmanage:notify',
} as const;

export interface NotifyRequest {
  readonly title: string;
  readonly body?: string;
  /** Silence the OS notification sound. */
  readonly silent?: boolean;
}

export interface NotifyResult {
  /** False when the OS reports notifications are unavailable. */
  readonly shown: boolean;
}
