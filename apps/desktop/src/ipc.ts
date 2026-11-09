/**
 * Shared IPC channel names and payload shapes for the preload bridge.
 *
 * Centralised so the preload (renderer side) and main process cannot drift apart, and
 * so the exposed surface is easy to audit: these channels are the *entire*
 * capability the web app is granted over the native shell.
 */

export const IPC = {
  /** Renderer -> main: resolve the installed desktop app version. */
  getVersion: 'tmanage:get-version',
  /** Renderer -> main: raise a native OS notification. */
  notify: 'tmanage:notify',
  /** Renderer -> main: open (or switch) the docked AI panel on an allow-listed assistant. */
  aiPanelOpen: 'tmanage:ai-panel:open',
  /** Renderer -> main: where the panel's website area is in the TManage page. */
  aiPanelBounds: 'tmanage:ai-panel:bounds',
  /** Renderer -> main: move the assistant into its own window beside TManage. */
  aiPanelPopOut: 'tmanage:ai-panel:pop-out',
  /** Renderer -> main: close the docked AI panel. */
  aiPanelClose: 'tmanage:ai-panel:close',
  /** Renderer -> main: the computer's idle state now (seconds since the last input, locked). */
  activitySample: 'tmanage:activity:sample',
  /** Main -> renderer: the computer was locked, unlocked, suspended or resumed. */
  activityEvent: 'tmanage:activity:event',
} as const;

/**
 * Automatic time tracking (FIX-2026-11-10). The whole-computer signal, and nothing else: how long
 * since the last keyboard or mouse input anywhere, and whether the screen is locked. No app or
 * window names, no URLs, no keystrokes, no screenshots ever cross this bridge.
 */
export interface ActivitySample {
  readonly idleSeconds: number;
  readonly locked: boolean;
}

export const ACTIVITY_EVENTS = ['locked', 'unlocked', 'suspended', 'resumed'] as const;
export type ActivityEvent = (typeof ACTIVITY_EVENTS)[number];

/** The website area in CSS pixels of the TManage page's viewport. */
export interface AiPanelBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly visible: boolean;
}

export interface AiPanelOpenRequest {
  /** A key of `AI_ASSISTANT_SITES`; never a URL. */
  readonly site: string;
  readonly bounds: AiPanelBounds;
}

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
