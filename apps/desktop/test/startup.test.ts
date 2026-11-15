import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isStrictBoolean } from '../src/ipc';
import {
  DEFAULT_STARTUP_STATE,
  HIDDEN_LAUNCH_FLAG,
  applyStartupDefault,
  chooseStartup,
  isHiddenLaunch,
  loadStartupState,
  loginItemOptions,
  parseStartupState,
  saveStartupState,
} from '../src/startup';

describe('start with the computer: saved choice', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tmanage-startup-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is off and not chosen by default', () => {
    expect(DEFAULT_STARTUP_STATE).toEqual({ openAtLogin: false, chosen: false });
    expect(loadStartupState(dir)).toEqual(DEFAULT_STARTUP_STATE);
  });

  it('saves and loads the choice', () => {
    saveStartupState(dir, { openAtLogin: true, chosen: true });
    expect(loadStartupState(dir)).toEqual({ openAtLogin: true, chosen: true });
    expect(JSON.parse(readFileSync(path.join(dir, 'startup-state.json'), 'utf8'))).toEqual({
      openAtLogin: true,
      chosen: true,
    });
  });

  it('falls back to the default on a corrupt or wrongly typed file, never a crash', () => {
    const file = path.join(dir, 'startup-state.json');
    writeFileSync(file, '{not json', 'utf8');
    expect(loadStartupState(dir)).toEqual(DEFAULT_STARTUP_STATE);
    writeFileSync(file, JSON.stringify({ openAtLogin: 'true', chosen: 1 }), 'utf8');
    expect(loadStartupState(dir)).toEqual(DEFAULT_STARTUP_STATE);
    expect(parseStartupState(null)).toEqual(DEFAULT_STARTUP_STATE);
    expect(parseStartupState({ openAtLogin: true })).toEqual(DEFAULT_STARTUP_STATE);
  });

  it('swallows a failed write', () => {
    const notADir = path.join(dir, 'file');
    writeFileSync(notADir, 'x', 'utf8');
    expect(() => saveStartupState(notADir, chooseStartup(true))).not.toThrow();
  });
});

describe('start with the computer: rules', () => {
  it('marks the person’s own toggle as chosen', () => {
    expect(chooseStartup(true)).toEqual({ openAtLogin: true, chosen: true });
    expect(chooseStartup(false)).toEqual({ openAtLogin: false, chosen: true });
  });

  it('applies the workspace default only while the person has not chosen', () => {
    expect(applyStartupDefault(DEFAULT_STARTUP_STATE, true)).toEqual({
      openAtLogin: true,
      chosen: false,
    });
    const optedOut = chooseStartup(false);
    expect(applyStartupDefault(optedOut, true)).toBe(optedOut);
    const optedIn = chooseStartup(true);
    expect(applyStartupDefault(optedIn, false)).toBe(optedIn);
  });

  it('detects a login launch from the --hidden flag or the OS report', () => {
    expect(HIDDEN_LAUNCH_FLAG).toBe('--hidden');
    expect(isHiddenLaunch(['tmanage.exe', '--hidden'])).toBe(true);
    expect(isHiddenLaunch(['tmanage.exe'])).toBe(false);
    expect(isHiddenLaunch(['tmanage.exe', '--hidden=no'])).toBe(false);
    expect(isHiddenLaunch(['tmanage.exe'], true)).toBe(true);
  });

  it('builds login item options that start quietly', () => {
    expect(loginItemOptions(true)).toEqual({ openAtLogin: true, args: ['--hidden'] });
    expect(loginItemOptions(false, 'C:/app')).toEqual({
      openAtLogin: false,
      args: ['C:/app', '--hidden'],
    });
  });

  it('accepts only a real boolean across the bridge', () => {
    expect(isStrictBoolean(true)).toBe(true);
    expect(isStrictBoolean(false)).toBe(true);
    for (const value of ['true', 1, 0, null, undefined, {}, []]) {
      expect(isStrictBoolean(value)).toBe(false);
    }
  });
});
