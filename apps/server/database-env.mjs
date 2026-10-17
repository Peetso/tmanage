// How the single-process Hostinger server finds its database, before `loadEnv` validates it.
//
// Hostinger's database setup for a Node.js web app writes these variables itself (the owner never
// sees the password): DATABASE_URL (mysql://user:pass@host:port/name, percent-encoded) and
// DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD. It provides ONE database user.
//
//   * DATABASE_URL is preferred; when it is absent it is assembled from the DB_* parts.
//   * A host of `localhost` is rewritten to 127.0.0.1: on Hostinger `localhost` can resolve to
//     ::1, and the database user is granted for 127.0.0.1 only.
//   * DATABASE_MIGRATION_URL and WORKER_DATABASE_URL default to DATABASE_URL. When either was
//     defaulted, or all three name the same user, DATABASE_SINGLE_USER=true is set — the explicit
//     acknowledgement @tmanage/config requires before it accepts one credential for all three.
//     Three distinct users, where a host offers them, keep the stricter three-user mode.

const DB_KEYS = ['DATABASE_URL', 'DATABASE_MIGRATION_URL', 'WORKER_DATABASE_URL'];

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Rewrite a `localhost` host to 127.0.0.1; any other URL (or a non-URL) is returned unchanged. */
export function pinLoopback(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'localhost') return url;
    parsed.hostname = '127.0.0.1';
    return parsed.toString();
  } catch {
    return url;
  }
}

function userOf(url) {
  try {
    return decodeURIComponent(new URL(url).username);
  } catch {
    return url;
  }
}

/** Build mysql://user:pass@host:port/name from Hostinger's DB_* parts, or undefined. */
function fromParts(source) {
  const host = nonEmpty(source['DB_HOST']);
  const name = nonEmpty(source['DB_NAME']);
  const user = nonEmpty(source['DB_USER']);
  if (!host || !name || !user) return undefined;
  const port = nonEmpty(source['DB_PORT']) ?? '3306';
  const password = source['DB_PASSWORD'] ?? '';
  const auth = `${encodeURIComponent(user)}${password ? `:${encodeURIComponent(password)}` : ''}`;
  return `mysql://${auth}@${host}:${port}/${encodeURIComponent(name)}`;
}

/**
 * Resolve the database variables. Returns the values to set (never logged — they hold the
 * password) and plain-language notes that are safe to log.
 */
export function resolveDatabaseEnv(source) {
  const values = {};
  const notes = [];

  let primary = nonEmpty(source['DATABASE_URL']);
  if (!primary) {
    primary = fromParts(source);
    if (primary)
      notes.push('database: DATABASE_URL assembled from DB_HOST/DB_PORT/DB_NAME/DB_USER');
  }
  if (!primary) {
    notes.push('database: neither DATABASE_URL nor DB_HOST/DB_NAME/DB_USER is set');
    return { values, notes };
  }
  values['DATABASE_URL'] = primary;

  let defaulted = false;
  for (const key of ['DATABASE_MIGRATION_URL', 'WORKER_DATABASE_URL']) {
    const given = nonEmpty(source[key]);
    values[key] = given ?? primary;
    if (!given) defaulted = true;
  }

  for (const key of DB_KEYS) {
    const pinned = pinLoopback(values[key]);
    if (pinned !== values[key]) {
      notes.push(`database: ${key} host localhost rewritten to 127.0.0.1`);
      values[key] = pinned;
    }
  }

  const users = new Set(DB_KEYS.map((key) => userOf(values[key])));
  const explicit = nonEmpty(source['DATABASE_SINGLE_USER']);
  if (explicit) {
    values['DATABASE_SINGLE_USER'] = explicit;
  } else if (defaulted || users.size === 1) {
    values['DATABASE_SINGLE_USER'] = 'true';
  }
  if (values['DATABASE_SINGLE_USER'] === 'true') {
    notes.push(
      'database: single-user mode — the app, migrations and the worker share one database user',
    );
  }
  return { values, notes };
}
