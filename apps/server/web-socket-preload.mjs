// Loaded with `node --import` into the `next start` child only (never into server.mjs itself).
//
// Hostinger shared hosting refuses loopback TCP between the app's own processes, so the child's
// HTTP server must listen on the private socket file (or, on Windows, the named pipe) that
// server.mjs names in TMANAGE_WEB_SOCKET. `next start` offers no socket option, so this preload
// redirects the ONE listen() call that targets the child's nominal PORT to that path. Any other
// listen() is left alone.
//
// The socket is created 0600: the umask is tightened around the bind (no window in which another
// account on the shared host could connect), then chmod'ed again once listening. Its directory is
// already 0700 (server.mjs prepares it).
import { chmodSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import process from 'node:process';

const socketPath = process.env['TMANAGE_WEB_SOCKET'];
const nominalPort = Number(process.env['PORT']);

/** True when listen(...args) asks for the nominal web port. */
function targetsNominalPort(args) {
  const [first] = args;
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    return Number(first) === nominalPort;
  }
  if (first && typeof first === 'object' && 'port' in first) {
    return Number(first.port) === nominalPort;
  }
  return false;
}

if (socketPath) {
  const originalListen = net.Server.prototype.listen;
  const isPipe = socketPath.startsWith('\\\\.\\pipe\\');
  let redirected = false;
  net.Server.prototype.listen = function listen(...args) {
    if (redirected || !targetsNominalPort(args)) return originalListen.apply(this, args);
    redirected = true;
    if (!isPipe) {
      try {
        unlinkSync(socketPath);
      } catch {
        // nothing left over
      }
      this.once('listening', () => {
        try {
          chmodSync(socketPath, 0o600);
        } catch (error) {
          process.stderr.write(`[web] could not restrict ${socketPath}: ${error}\n`);
        }
      });
    }
    const callback = args.find((arg) => typeof arg === 'function');
    const previousUmask = isPipe ? undefined : process.umask(0o177);
    try {
      return callback
        ? originalListen.call(this, socketPath, callback)
        : originalListen.call(this, socketPath);
    } finally {
      if (previousUmask !== undefined) process.umask(previousUmask);
    }
  };
}
