import { useSyncExternalStore } from 'react';

/**
 * The docked panel's state (desktop app only), kept outside React so it survives the shell
 * remounting on every client-side page change: the assistant shown, and the panel's width.
 */

export const PANEL_MIN_WIDTH = 320;
export const PANEL_DEFAULT_WIDTH = 400;
export const PANEL_MAX_WIDTH = 720;
const WIDTH_STORAGE_KEY = 'tmanage.ai-panel.width';

export interface PanelState {
  readonly siteKey: string | null;
  readonly width: number;
}

let state: PanelState = { siteKey: null, width: PANEL_DEFAULT_WIDTH };
let widthLoaded = false;
const listeners = new Set<() => void>();

const SERVER_STATE: PanelState = { siteKey: null, width: PANEL_DEFAULT_WIDTH };

function emit(): void {
  syncDocument();
  for (const listener of listeners) listener();
}

/** The app frame makes room for the panel through these two hooks (see ai-panel.css). */
function syncDocument(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (state.siteKey) {
    root.setAttribute('data-ai-panel', 'open');
    root.style.setProperty('--tm-ai-panel-width', `${state.width}px`);
  } else {
    root.removeAttribute('data-ai-panel');
    root.style.removeProperty('--tm-ai-panel-width');
  }
}

export function clampWidth(width: number, viewportWidth: number): number {
  const max = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, Math.floor(viewportWidth / 2)));
  return Math.round(Math.min(max, Math.max(PANEL_MIN_WIDTH, width)));
}

function loadWidth(): void {
  if (widthLoaded) return;
  widthLoaded = true;
  try {
    const stored = Number(window.localStorage.getItem(WIDTH_STORAGE_KEY));
    if (Number.isFinite(stored) && stored > 0) {
      state = { ...state, width: clampWidth(stored, window.innerWidth) };
    }
  } catch {
    // Storage is a convenience; the default width stands.
  }
}

export function showPanel(siteKey: string): void {
  loadWidth();
  state = { ...state, siteKey };
  emit();
}

export function hidePanel(): void {
  state = { ...state, siteKey: null };
  emit();
}

export function setPanelWidth(width: number): void {
  state = { ...state, width: clampWidth(width, window.innerWidth) };
  try {
    window.localStorage.setItem(WIDTH_STORAGE_KEY, String(state.width));
  } catch {
    // Not remembered in a private window.
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePanelState(): PanelState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => SERVER_STATE,
  );
}
