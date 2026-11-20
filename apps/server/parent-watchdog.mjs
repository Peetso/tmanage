// Loaded with `node --import` into the `next start` child only (never into server.mjs itself).
//
// R2 (2026-11-21; RT-6, DC-3): the web child must end when its parent ends. server.mjs starts it
// with spawn(), and LiteSpeed's lsnode loader gives only fork()ed children its LSNODE_GUARD_PPID
// watchdog (https://raw.githubusercontent.com/litespeedtech/openlitespeed/master/dist/fcgi-bin/lsnode.js).
// On a graceful exit server.mjs (and lsnode) SIGTERM the child, but if server.mjs is SIGKILLed
// (lsnode terminateSelf after 3 s, Hostinger's Stop, an out-of-memory kill) the child is orphaned
// and keeps its ~10 threads against the plan's process limit until "Stop running processes".
// Hostinger names this shape, "an Express.js server that starts Next.js", as a cause of leftover
// processes: https://www.hostinger.com/support/how-to-fix-503-and-too-many-processes-errors-on-node-js-websites-at-hostinger/
//
// server.mjs passes its pid in TMANAGE_PARENT_PID. The parent counts as gone when
//   - an IPC channel exists and disconnects (none today; kept so a later fork() is covered), or
//   - process.ppid no longer equals that pid (Linux re-parents an orphan to init or a subreaper;
//     checked only when the two matched at start, so a wrapper process cannot trip it), or
//   - process.kill(pid, 0) throws ESRCH (the pid no longer exists; the Windows path, where ppid
//     never changes). EPERM means the pid exists, so it counts as alive.
// The poll timer is unref()'d: it never keeps the child alive on its own.
import process from 'node:process';

export const PARENT_PID_ENV = 'TMANAGE_PARENT_PID';
export const PARENT_WATCH_MS_ENV = 'TMANAGE_PARENT_WATCH_MS';
export const DEFAULT_WATCH_MS = 2000;
const MIN_WATCH_MS = 50;

/** True while a process with this pid exists (EPERM: it exists, owned by someone else). */
export function pidExists(pid, kill = process.kill.bind(process)) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** The poll interval: the env override (tests) when it is a sane number, else the default. */
export function watchInterval(env) {
  const value = Number(env[PARENT_WATCH_MS_ENV]);
  return Number.isFinite(value) && value >= MIN_WATCH_MS ? value : DEFAULT_WATCH_MS;
}

/**
 * Watch `parentPid` and call `onGone(reason)` once when it has gone. Returns a stop function.
 * Every dependency is injectable for the unit test.
 */
export function startParentWatchdog({
  parentPid,
  intervalMs = DEFAULT_WATCH_MS,
  proc = process,
  exists = pidExists,
  onGone,
}) {
  let done = false;
  const usePpid = proc.ppid === parentPid;
  const timer = setInterval(() => {
    if (usePpid && proc.ppid !== parentPid) fire(`re-parented to ${proc.ppid}`);
    else if (!exists(parentPid)) fire('no such process');
  }, intervalMs);
  timer.unref?.();
  function fire(reason) {
    if (done) return;
    done = true;
    clearInterval(timer);
    onGone(reason);
  }
  if (proc.channel) proc.once('disconnect', () => fire('IPC channel closed'));
  return () => {
    done = true;
    clearInterval(timer);
  };
}

const parentPid = Number(process.env[PARENT_PID_ENV]);
if (Number.isInteger(parentPid) && parentPid > 0) {
  startParentWatchdog({
    parentPid,
    intervalMs: watchInterval(process.env),
    onGone: (reason) => {
      process.stderr.write(
        `[web] parent ${parentPid} is gone (${reason}); exiting (pid ${process.pid})\n`,
      );
      process.exit(0);
    },
  });
}
