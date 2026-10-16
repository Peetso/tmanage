/**
 * Window size/position persistence for the desktop companion.
 *
 * Native window behaviour (42-INTERACTION §"Desktop") includes remembering where the
 * user left the window. State is a tiny JSON file in the app's userData directory; the
 * serialisation and validation are pure so they can be reasoned about without a disk.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface WindowState {
  readonly width: number;
  readonly height: number;
  /** Absent until the window has been moved; Electron centres when undefined. */
  readonly x?: number;
  readonly y?: number;
  readonly maximized: boolean;
}

export const DEFAULT_WINDOW_STATE: WindowState = {
  width: 1280,
  height: 832,
  maximized: false,
};

const STATE_FILE = 'window-state.json';

/** Parse and sanity-check a persisted state blob; unknown/corrupt input yields defaults. */
export function parseWindowState(raw: unknown): WindowState {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_WINDOW_STATE;
  const o = raw as Record<string, unknown>;
  const width = positiveInt(o['width'], DEFAULT_WINDOW_STATE.width);
  const height = positiveInt(o['height'], DEFAULT_WINDOW_STATE.height);
  const maximized = typeof o['maximized'] === 'boolean' ? o['maximized'] : false;
  const state: WindowState = { width, height, maximized };
  const x = o['x'];
  const y = o['y'];
  if (Number.isFinite(x) && Number.isFinite(y)) {
    return { ...state, x: Math.trunc(x as number), y: Math.trunc(y as number) };
  }
  return state;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

/** Read the saved state from `userDataDir`, or defaults if none/unreadable. */
export function loadWindowState(userDataDir: string): WindowState {
  const file = path.join(userDataDir, STATE_FILE);
  try {
    if (!existsSync(file)) return DEFAULT_WINDOW_STATE;
    return parseWindowState(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return DEFAULT_WINDOW_STATE;
  }
}

/** Persist `state` under `userDataDir`; failures are swallowed (best-effort convenience). */
export function saveWindowState(userDataDir: string, state: WindowState): void {
  try {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(path.join(userDataDir, STATE_FILE), JSON.stringify(state), 'utf8');
  } catch {
    // Losing remembered bounds is not worth crashing a quit over.
  }
}
