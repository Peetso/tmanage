/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Packaged-shell smoke harness for the TManage desktop companion (module 22).
 *
 * This file is the Electron *main entry* for the smoke run. It is launched by the
 * `launch.smoke.ts` spec through the real `electron` binary, so everything below runs
 * inside a genuine Electron main process — not a mocked or node-only stand-in.
 *
 * Why a node-level launch smoke rather than Playwright's `_electron`: the `@playwright/test`
 * package does not resolve from this workspace's lockfile for `@tmanage/desktop`, and adding
 * it would mutate the lockfile (breaking `pnpm install --frozen-lockfile`). So we drive the
 * shell with Electron itself and the already-present toolchain.
 *
 * What it proves, against a local stub origin and using the *shipped* compiled artifacts in
 * `dist/` (never the TypeScript source):
 *   1. the real `dist/main.js` boots and opens its BrowserWindow onto the configured origin;
 *   2. the navigation / external-link allowlist is wired onto that window AND refuses
 *      off-origin / dangerous targets while keeping same-origin navigation in-app;
 *   3. the tray is constructible and the `tmanage://` deep-link + second-instance handlers
 *      are registered and route back onto the app origin (never a foreign one);
 *   4. the process quits cleanly via the normal `app.quit()` path.
 *
 * It emits a single `SMOKE_RESULT <json>` line on stdout; the spec parses and asserts it.
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';

/** apps/desktop root, derived from this file's compiled location (test/smoke/dist/harness.js). */
const desktopRoot = path.join(__dirname, '..', '..', '..');
const distDir = path.join(desktopRoot, 'dist');
const assetsDir = path.join(desktopRoot, 'assets');

/** Shipped, compiled policy/surface modules — the exact code a packaged build would run. */
const navGuard = require(path.join(distDir, 'navigation-guard.js')) as {
  classifyNavigation: (url: string, origin: string) => 'allow' | 'external' | 'block';
  isInAppNavigation: (url: string, origin: string) => boolean;
  shouldOpenExternally: (url: string, origin: string) => boolean;
};
const deepLink = require(path.join(distDir, 'deep-link.js')) as {
  resolveDeepLink: (link: string, base: string) => string | null;
  findDeepLinkArg: (argv: readonly string[]) => string | null;
};
const trayModule = require(path.join(distDir, 'tray.js')) as {
  createTray: (
    dir: string,
    cbs: {
      onOpen: () => void;
      onQuit: () => void;
      startsAtLogin: () => boolean;
      onStartsAtLoginChange: (on: boolean) => void;
    },
  ) => { setToolTip: (s: string) => void; destroy: () => void };
};

type Checks = {
  windowOpened: boolean;
  loadedOnOrigin: boolean;
  activityBridge: boolean;
  startupBridge: boolean;
  navGuardWired: boolean;
  navGuardAllowsSameOrigin: boolean;
  navGuardRefusesOffAllowlist: boolean;
  navGuardBlocksDangerousScheme: boolean;
  trayConstructs: boolean;
  deepLinkRoutesOnOrigin: boolean;
  deepLinkNeverEscapesOrigin: boolean;
  deepLinkHandlersRegistered: boolean;
};

const checks: Checks = {
  windowOpened: false,
  loadedOnOrigin: false,
  activityBridge: false,
  startupBridge: false,
  navGuardWired: false,
  navGuardAllowsSameOrigin: false,
  navGuardRefusesOffAllowlist: false,
  navGuardBlocksDangerousScheme: false,
  trayConstructs: false,
  deepLinkRoutesOnOrigin: false,
  deepLinkNeverEscapesOrigin: false,
  deepLinkHandlersRegistered: false,
};

function emit(extra: Record<string, unknown> = {}): void {
  const passed = Object.values(checks).every(Boolean);
  const payload = { passed, checks, ...extra };
  process.stdout.write(`SMOKE_RESULT ${JSON.stringify(payload)}\n`);
}

/** Stop the app without tripping the hide-to-tray guard; code reflects pass/fail. */
function finish(passed: boolean): void {
  // Exercise the real quit path (before-quit sets the quitting flag, so the window's
  // close handler does not hide-to-tray). A watchdog force-exits if shutdown ever stalls.
  const watchdog = setTimeout(() => app.exit(passed ? 0 : 1), 8000);
  watchdog.unref();
  app.once('will-quit', () => clearTimeout(watchdog));
  if (!passed) process.exitCode = 1;
  app.quit();
}

function waitForLoad(win: BrowserWindow, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const wc = win.webContents;
    if (!wc.isLoading() && wc.getURL().length > 0) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    wc.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve(true);
    });
    wc.once('did-fail-load', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function runChecks(stubUrl: string): Promise<void> {
  const origin = new URL(stubUrl).origin;

  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    emit({ error: 'no BrowserWindow was created by dist/main.js' });
    finish(false);
    return;
  }
  checks.windowOpened = true;

  const loaded = await waitForLoad(win, 20000);
  const wc = win.webContents;
  checks.loadedOnOrigin = loaded && new URL(wc.getURL()).origin === origin;

  // The sandboxed preload exposes the automatic-tracking bridge, and a sample carries exactly the
  // idle seconds and the lock state.
  try {
    const sample = (await wc.executeJavaScript(
      'window.tmanageDesktop && window.tmanageDesktop.activity.sample()',
    )) as { idleSeconds?: unknown; locked?: unknown } | null;
    checks.activityBridge =
      sample !== null &&
      typeof sample.idleSeconds === 'number' &&
      typeof sample.locked === 'boolean' &&
      Object.keys(sample).sort().join() === 'idleSeconds,locked';
  } catch {
    checks.activityBridge = false;
  }

  // The start-with-the-computer bridge answers its state, and refuses a non-boolean before it
  // reaches the main process. Read-only here: the smoke never registers a real login item.
  try {
    const state = (await wc.executeJavaScript('window.tmanageDesktop.startup.get()')) as {
      openAtLogin?: unknown;
      chosen?: unknown;
    } | null;
    const refusesNonBoolean = (await wc.executeJavaScript(
      "window.tmanageDesktop.startup.set('true').then(() => false, () => true)",
    )) as boolean;
    checks.startupBridge =
      state !== null &&
      state.openAtLogin === false &&
      state.chosen === false &&
      Object.keys(state).sort().join() === 'chosen,openAtLogin' &&
      refusesNonBoolean === true;
  } catch {
    checks.startupBridge = false;
  }

  // The real main wires the allowlist onto will-navigate / will-redirect of this window.
  checks.navGuardWired =
    wc.listenerCount('will-navigate') >= 1 && wc.listenerCount('will-redirect') >= 1;

  // The shipped policy itself: same-origin stays, foreign web goes external, file: is blocked.
  checks.navGuardAllowsSameOrigin = navGuard.isInAppNavigation(`${origin}/acme/home`, origin);
  checks.navGuardRefusesOffAllowlist =
    !navGuard.isInAppNavigation('https://evil.example.com/x', origin) &&
    navGuard.shouldOpenExternally('https://evil.example.com/x', origin);
  checks.navGuardBlocksDangerousScheme =
    navGuard.classifyNavigation('file:///C:/Windows/System32/x', origin) === 'block';

  // Tray is constructible in this real Electron runtime against the shipped asset dir.
  try {
    const tray = trayModule.createTray(assetsDir, {
      onOpen: () => {},
      onQuit: () => {},
      startsAtLogin: () => false,
      onStartsAtLoginChange: () => {},
    });
    checks.trayConstructs = typeof tray?.destroy === 'function';
    tray?.destroy();
  } catch {
    checks.trayConstructs = false;
  }

  // Deep-link routing resolves onto the app origin and cannot be steered off it.
  const routed = deepLink.resolveDeepLink('tmanage://acme/projects/42?tab=files#notes', stubUrl);
  checks.deepLinkRoutesOnOrigin = routed === `${origin}/acme/projects/42?tab=files#notes`;
  const foreign = deepLink.resolveDeepLink('tmanage://evil.example.com/steal', stubUrl);
  checks.deepLinkNeverEscapesOrigin = foreign !== null && new URL(foreign).origin === origin;

  // main.js registers the OS deep-link hand-off (second-instance on all platforms, open-url too).
  checks.deepLinkHandlersRegistered =
    app.listenerCount('second-instance') >= 1 && app.listenerCount('open-url') >= 1;

  const passed = Object.values(checks).every(Boolean);
  emit();
  finish(passed);
}

function main(): void {
  // Isolate any window-state writes to a throwaway dir.
  const userData = path.join(os.tmpdir(), `tmanage-desktop-smoke-${process.pid}`);

  const stub = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>TManage smoke stub</title><main>stub</main>');
  });

  stub.listen(0, '127.0.0.1', () => {
    const address = stub.address();
    if (!address || typeof address === 'string') {
      emit({ error: 'stub server did not bind a TCP port' });
      finish(false);
      return;
    }
    const stubUrl = `http://127.0.0.1:${address.port}`;
    process.env['TMANAGE_URL'] = stubUrl;

    // Boot the REAL shell. Requiring it drives app bootstrap, window, tray and protocol.
    require(path.join(distDir, 'main.js'));
    app.setPath('userData', userData);

    void app.whenReady().then(() =>
      runChecks(stubUrl).finally(() => {
        try {
          stub.close();
        } catch {
          /* best effort */
        }
      }),
    );
  });

  const guard = setTimeout(() => {
    emit({ error: 'smoke timed out before completing checks' });
    finish(false);
  }, 45000);
  guard.unref();
}

main();
