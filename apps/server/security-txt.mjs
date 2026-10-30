// `GET /.well-known/security.txt` — RFC 9116 (56-17). Answered by the single-process server
// itself, ahead of the web hand-off: it is a web path, not an API one (`isApiPath` stays false
// for it, boot-guards.test.mjs), and it needs no database, no session and no Next render.
//
// The file is built from the environment once per request (cheap, a handful of lines):
//
//   Contact: mailto:<SECURITY_CONTACT_EMAIL | EMAIL_SECURITY_FROM_ADDRESS | security@<host>>
//   Expires: <now + 180 days, ISO 8601 UTC>   (RFC 9116 §2.5.5: less than a year ahead)
//   Preferred-Languages: en, ar
//   Policy: <WEB_PUBLIC_URL>/security/disclosure
//   Canonical: <WEB_PUBLIC_URL>/.well-known/security.txt
//
// The disclosure page's form posts to `POST /v1/public/security-reports` (the API). No
// `Encryption` line until a PGP key exists (Peter, optional). GET and HEAD only; anything else is
// a 405 with `Allow`. The legacy `/security.txt` path is not served.

export const SECURITY_TXT_PATH = '/.well-known/security.txt';
/** How far ahead `Expires` is stamped. RFC 9116 recommends under a year; half a year is safe. */
export const EXPIRES_AHEAD_MS = 180 * 24 * 60 * 60 * 1000;

/** Whether a request URL is the security.txt path (exact; a query string is ignored). */
export function isSecurityTxtPath(url) {
  return (url ?? '').split('?')[0] === SECURITY_TXT_PATH;
}

function present(value) {
  const text = String(value ?? '').trim();
  return text === '' ? undefined : text;
}

/** One header line value with no CR/LF in it: an env value can never add a field. */
function oneLine(value) {
  return String(value).replace(/[\r\n]+/g, ' ');
}

/** The origin the file speaks for: `WEB_PUBLIC_URL`, trailing slash dropped. */
function publicOrigin(env) {
  const raw = present(env.WEB_PUBLIC_URL) ?? 'http://localhost:3000';
  try {
    return new URL(raw).origin;
  } catch {
    return 'http://localhost:3000';
  }
}

/** The security.txt body for this environment at `now`. */
export function securityTxt(env, now = new Date()) {
  const origin = publicOrigin(env);
  const contact =
    present(env.SECURITY_CONTACT_EMAIL) ??
    present(env.EMAIL_SECURITY_FROM_ADDRESS) ??
    `security@${new URL(origin).hostname}`;
  const expires = new Date(now.getTime() + EXPIRES_AHEAD_MS)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  return [
    `Contact: mailto:${oneLine(contact)}`,
    `Expires: ${expires}`,
    'Preferred-Languages: en, ar',
    `Policy: ${origin}/security/disclosure`,
    `Canonical: ${origin}${SECURITY_TXT_PATH}`,
    '',
  ].join('\n');
}

/** The request handler, over `env` (process.env in server.mjs) and an injectable clock. */
export function createSecurityTxtHandler(env = process.env, now = () => new Date()) {
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-length': '0' });
      res.end();
      return;
    }
    const body = securityTxt(env, now());
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}
