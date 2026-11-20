/**
 * OFFSITE-BACKUP. AWS Signature Version 4 for the S3-compatible API of OCI Object Storage, on
 * `node:crypto` (no SDK: one dependency fewer in the supply chain, SE-7).
 *
 * OCI accepts SigV4 only ("AWS Signature Version 2 (SigV2) isn't supported", Oracle, *Amazon S3
 * Compatibility API Support*). The algorithm is AWS's *Signature Version 4 signing process*:
 * canonical request → string to sign → HMAC chain `AWS4<secret>` / date / region / service /
 * `aws4_request` → signature. `sigv4.test.ts` checks it against the AWS SigV4 test suite
 * (`get-vanilla`, `get-vanilla-query-order-key-case`, `post-x-www-form-urlencoded`, as shipped in
 * botocore's `tests/unit/auth/aws4_testsuite`).
 *
 * S3 rule kept here: the path is URI-encoded once per segment (S3 does not double-encode), and
 * the payload hash is sent as `x-amz-content-sha256` and signed, so the server can refuse a body
 * that differs from the one that was signed.
 */
import { createHash, createHmac } from 'node:crypto';

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface SigV4Request {
  readonly method: string;
  /** Absolute path, not yet encoded (`/bucket/db/20261120T030000Z/manifest.json`). */
  readonly path: string;
  /** Query parameters, not yet encoded. */
  readonly query?: Readonly<Record<string, string>>;
  /** Every header to send and sign (names are lower-cased here); must include `host`. */
  readonly headers: Readonly<Record<string, string>>;
  /** Hex SHA-256 of the body (`EMPTY_SHA256` for none). */
  readonly payloadSha256: string;
}

export const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

/** RFC 3986 unreserved characters stay; everything else is `%XX`, upper-case hex. */
export function uriEncode(value: string, keepSlash = false): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/u.test(c) || (keepSlash && c === '/')) out += c;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();
const sha256Hex = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex');

/** `20150830T123600Z` from a date. */
export function amzDate(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}/u, '');
}

export function canonicalQuery(query: Readonly<Record<string, string>> = {}): string {
  return Object.entries(query)
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** The canonical request, and the signed-header list it names. */
export function canonicalRequest(request: SigV4Request): {
  readonly text: string;
  readonly signedHeaders: string;
} {
  const headers = Object.entries(request.headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/gu, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = headers.map(([name]) => name).join(';');
  const text = [
    request.method.toUpperCase(),
    uriEncode(request.path, true),
    canonicalQuery(request.query),
    headers.map(([name, value]) => `${name}:${value}\n`).join(''),
    signedHeaders,
    request.payloadSha256,
  ].join('\n');
  return { text, signedHeaders };
}

/**
 * The `Authorization` header for `request`. `request.headers` must already carry `x-amz-date`
 * equal to {@link amzDate}(`at`) (and, for S3, `x-amz-content-sha256`).
 */
export function authorization(
  request: SigV4Request,
  credentials: SigV4Credentials,
  region: string,
  service: string,
  at: Date,
): string {
  const stamp = amzDate(at);
  const day = stamp.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const { text, signedHeaders } = canonicalRequest(request);
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(text)].join('\n');
  const key = hmac(
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), service),
    'aws4_request',
  );
  const signature = createHmac('sha256', key).update(toSign, 'utf8').digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}
