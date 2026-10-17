import { accessSync, constants, existsSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * The boot check for `STORAGE_LOCAL_ROOT`, the directory the local filesystem driver keeps
 * uploads under on Hostinger shared hosting.
 *
 * Why it refuses to start rather than warn: a root the web server can serve (anything under
 * `public_html`, or any other web root) would hand every stored file out by its path, past the
 * authenticated download route and past the tenant checks that route makes. The only safe
 * place for the bytes is a directory no URL reaches, so a root that might be one is fatal.
 *
 * Path segments are compared lower-cased against {@link FORBIDDEN_ROOT_SEGMENTS}, both for the
 * path as written and for its real path, so a symlink cannot smuggle the root into a web root.
 * The path itself may appear in the error; it is configuration, not a secret.
 */

/** Directory names that are, or conventionally sit under, a web server's document root. */
export const FORBIDDEN_ROOT_SEGMENTS: readonly string[] = [
  'public_html',
  'public',
  'www',
  'wwwroot',
  'htdocs',
  'httpdocs',
  'html',
  'static',
  '.next',
  'out',
];

/** The configured root cannot hold uploads safely; the API must not start with it. */
export class UnsafeStorageRootError extends Error {
  constructor(readonly reason: string) {
    super(`STORAGE_LOCAL_ROOT is not safe: ${reason}`);
    this.name = 'UnsafeStorageRootError';
  }
}

export interface PrepareLocalStorageRootOptions {
  /** Directories the web server serves (or the app's own deploy directory); checked if they exist. */
  readonly webRoots?: readonly string[];
}

function rejectForbiddenSegments(candidate: string): void {
  for (const segment of candidate.split(path.sep)) {
    if (FORBIDDEN_ROOT_SEGMENTS.includes(segment.toLowerCase())) {
      throw new UnsafeStorageRootError(`${candidate} must be outside public_html and any web root`);
    }
  }
}

function isSameOrInside(child: string, parent: string): boolean {
  return (
    child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)
  );
}

/**
 * Validates, creates (mode 0700) and resolves the local storage root, answering its real path.
 * Synchronous on purpose: it runs inside a Nest `DynamicModule` factory at boot.
 *
 * @throws UnsafeStorageRootError when the root is relative, contains `..` or NUL, lies in or
 *   contains a web root, or is not readable and writable by this process.
 */
export function prepareLocalStorageRoot(
  root: string,
  options: PrepareLocalStorageRootOptions = {},
): string {
  if (typeof root !== 'string' || root.length === 0) {
    throw new UnsafeStorageRootError('must be a non-empty path');
  }
  if (root.includes('\0')) {
    throw new UnsafeStorageRootError('must not contain a NUL character');
  }
  if (!path.isAbsolute(root)) {
    throw new UnsafeStorageRootError(`${root} must be an absolute path`);
  }
  if (root.split(/[\\/]/).includes('..')) {
    throw new UnsafeStorageRootError(`${root} must not contain a '..' segment`);
  }

  const resolved = path.resolve(root);
  rejectForbiddenSegments(resolved);
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const real = realpathSync(resolved);
  rejectForbiddenSegments(real);

  for (const webRoot of options.webRoots ?? []) {
    if (!existsSync(webRoot)) continue;
    const realWebRoot = realpathSync(webRoot);
    if (isSameOrInside(real, realWebRoot)) {
      throw new UnsafeStorageRootError(`${real} must be outside the web root ${realWebRoot}`);
    }
    if (isSameOrInside(realWebRoot, real)) {
      throw new UnsafeStorageRootError(`${real} must not contain the web root ${realWebRoot}`);
    }
  }

  try {
    accessSync(real, constants.R_OK | constants.W_OK);
  } catch {
    throw new UnsafeStorageRootError(`${real} is not readable and writable`);
  }
  return real;
}
