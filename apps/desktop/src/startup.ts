/**
 * Start with the computer (FIX-2026-11-10, item 16): the pure half of auto-launch at login.
 *
 * The person's choice lives in a tiny JSON file in userData, like the window state. `chosen`
 * turns true once the person flips the toggle themself; from then on a workspace default never
 * changes it. Kept free of Electron so every rule here is unit-tested on its own; `main.ts` reads
 * and writes the OS login item with the options built here.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isStrictBoolean, type StartupState } from './ipc';

export const DEFAULT_STARTUP_STATE: StartupState = { openAtLogin: false, chosen: false };

/** Passed by the OS login item so a login launch starts quietly in the tray. */
export const HIDDEN_LAUNCH_FLAG = '--hidden';

const STATE_FILE = 'startup-state.json';

/** Parse a persisted blob; anything unknown or corrupt yields the default. */
export function parseStartupState(raw: unknown): StartupState {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_STARTUP_STATE;
  const o = raw as Record<string, unknown>;
  const openAtLogin = o['openAtLogin'];
  const chosen = o['chosen'];
  if (!isStrictBoolean(openAtLogin) || !isStrictBoolean(chosen)) return DEFAULT_STARTUP_STATE;
  return { openAtLogin, chosen };
}

/** Read the saved choice from `userDataDir`, or the default if none or unreadable. */
export function loadStartupState(userDataDir: string): StartupState {
  const file = path.join(userDataDir, STATE_FILE);
  try {
    if (!existsSync(file)) return DEFAULT_STARTUP_STATE;
    return parseStartupState(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return DEFAULT_STARTUP_STATE;
  }
}

/** Persist `state` under `userDataDir`; a failed write is swallowed, never a crash. */
export function saveStartupState(userDataDir: string, state: StartupState): void {
  try {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(
      path.join(userDataDir, STATE_FILE),
      JSON.stringify({ openAtLogin: state.openAtLogin, chosen: state.chosen }),
      'utf8',
    );
  } catch {
    // Forgetting the toggle is not worth crashing over; the OS login item still holds it.
  }
}

/** The person flipped the toggle: their choice, from now on. */
export function chooseStartup(openAtLogin: boolean): StartupState {
  return { openAtLogin, chosen: true };
}

/** The workspace default applies only while the person has not chosen; it never sets `chosen`. */
export function applyStartupDefault(state: StartupState, openAtLogin: boolean): StartupState {
  if (state.chosen) return state;
  return { openAtLogin, chosen: false };
}

/** True when this launch came from the login item (or macOS reports a login launch). */
export function isHiddenLaunch(argv: readonly string[], wasOpenedAtLogin = false): boolean {
  return wasOpenedAtLogin || argv.includes(HIDDEN_LAUNCH_FLAG);
}

export interface LoginItemOptions {
  readonly openAtLogin: boolean;
  readonly args: string[];
}

/**
 * Options for `app.setLoginItemSettings` (and the matching `getLoginItemSettings` query, which on
 * Windows must name the same args). `devEntry` is the app script when running unpackaged
 * (`electron .`), so the login item starts this app rather than a bare Electron.
 */
export function loginItemOptions(openAtLogin: boolean, devEntry?: string): LoginItemOptions {
  const args = devEntry === undefined ? [HIDDEN_LAUNCH_FLAG] : [devEntry, HIDDEN_LAUNCH_FLAG];
  return { openAtLogin, args };
}
