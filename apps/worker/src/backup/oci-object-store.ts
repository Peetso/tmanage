/**
 * OFFSITE-BACKUP. The few S3 calls the off-site backup needs, against the S3-compatible API of
 * OCI Object Storage (Oracle, *Amazon S3 Compatibility API*):
 *
 * - path-style URLs `https://<namespace>.compat.objectstorage.<region>.oci.customer-oci.com/<bucket>/<key>`
 *   (Oracle's dedicated endpoint, recommended "for the strongest security posture"; the legacy
 *   `…<region>.oraclecloud.com` form still works and can be given as `BACKUP_OCI_ENDPOINT`);
 * - SigV4 with the bucket's region (`sigv4.ts`) and a Customer Secret Key pair;
 * - only the operations Oracle lists as supported: PutObject, GetObject, DeleteObject and
 *   ListObjects (version 1: ListObjectsV2 is not in Oracle's list, so it is not used).
 *
 * Every call has a deadline (ST-1). An error names the operation, the HTTP status and the S3
 * error code only: never a header, so never the signature or the key id.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { EMPTY_SHA256, amzDate, authorization, canonicalQuery, uriEncode } from './sigv4.js';
import type { SigV4Credentials } from './sigv4.js';

export interface HttpRequest {
  readonly method: 'GET' | 'PUT' | 'DELETE';
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  /** A fresh body stream; called at most once. */
  readonly body?: () => Readable;
  readonly timeoutMs: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: AsyncIterable<Buffer>;
}

/** The network edge, injected so the client is unit-tested without sockets (IP-14). */
export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

/** The real transport: `node:https`, with an explicit `Content-Length` for streamed bodies. */
export const httpsTransport: HttpTransport = (req) =>
  new Promise<HttpResponse>((resolve, reject) => {
    const signal = AbortSignal.timeout(req.timeoutMs);
    const outgoing = httpsRequest(
      req.url,
      { method: req.method, headers: req.headers, signal },
      (incoming) => {
        resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: incoming });
      },
    );
    outgoing.on('error', reject);
    if (req.body === undefined) {
      outgoing.end();
      return;
    }
    pipeline(req.body(), outgoing).catch(reject);
  });

export class ObjectStoreError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`object store ${operation} -> ${String(status)}${code === null ? '' : ` ${code}`}`);
    this.name = 'ObjectStoreError';
  }
}

export interface ObjectStoreConfig {
  /** `https://<namespace>.compat.objectstorage.<region>.oci.customer-oci.com` */
  readonly endpoint: URL;
  readonly region: string;
  readonly bucket: string;
  readonly credentials: SigV4Credentials;
  readonly transport?: HttpTransport;
  readonly now?: () => Date;
  /** Per-call deadline for small calls (list, delete). */
  readonly callTimeoutMs?: number;
  /** Deadline for one object's upload or read-back. */
  readonly transferTimeoutMs?: number;
}

export interface StoredObject {
  readonly key: string;
  readonly size: number;
}

export interface LocalFile {
  readonly path: string;
  readonly bytes: number;
  /** Hex SHA-256: signed as `x-amz-content-sha256`, so the store checks the body against it. */
  readonly sha256: string;
  /** Base64 MD5: sent as `Content-MD5`, the store's second integrity check of the body. */
  readonly md5Base64: string;
}

export interface ObjectDigest {
  readonly bytes: number;
  readonly sha256: string;
}

const xmlUnescape = (s: string): string =>
  s
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&');

const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'u').exec(xml);
  return m?.[1] === undefined ? null : xmlUnescape(m[1]);
};

/** The `<Contents>` of a ListObjects (v1) answer, its truncation flag and the next marker. */
export function parseListObjects(xml: string): {
  readonly objects: readonly StoredObject[];
  readonly truncated: boolean;
  readonly nextMarker: string | null;
} {
  const objects: StoredObject[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gu)) {
    const block = m[1] ?? '';
    const key = tag(block, 'Key');
    const size = Number(tag(block, 'Size'));
    if (key !== null && Number.isFinite(size)) objects.push({ key, size });
  }
  return {
    objects,
    truncated: tag(xml, 'IsTruncated') === 'true',
    nextMarker: tag(xml, 'NextMarker'),
  };
}

async function readAll(body: AsyncIterable<Buffer>, limit = 1 << 20): Promise<string> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > limit) throw new Error('object store answer is too large');
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString('utf8');
}

async function drain(body: AsyncIterable<Buffer>): Promise<void> {
  for await (const chunk of body) void chunk;
}

export class OciObjectStore {
  private readonly transport: HttpTransport;
  private readonly now: () => Date;
  private readonly callTimeoutMs: number;
  private readonly transferTimeoutMs: number;

  constructor(private readonly config: ObjectStoreConfig) {
    this.transport = config.transport ?? httpsTransport;
    this.now = config.now ?? (() => new Date());
    this.callTimeoutMs = config.callTimeoutMs ?? 30_000;
    this.transferTimeoutMs = config.transferTimeoutMs ?? 15 * 60_000;
  }

  /** `oci:<bucket>/<key>`: a location for the run record, never a link or a credential. */
  location(key: string): string {
    return `oci:${this.config.bucket}/${key}`;
  }

  async putObject(key: string, file: LocalFile, contentType: string): Promise<void> {
    const res = await this.send(
      'PutObject',
      'PUT',
      key,
      {},
      {
        'content-length': String(file.bytes),
        'content-md5': file.md5Base64,
        'content-type': contentType,
      },
      file.sha256,
      () => createReadStream(file.path),
      this.transferTimeoutMs,
    );
    await drain(res.body);
  }

  /** Reads the stored object back and hashes it: the end-to-end check of an upload. */
  async digestObject(key: string): Promise<ObjectDigest> {
    const res = await this.send(
      'GetObject',
      'GET',
      key,
      {},
      {},
      EMPTY_SHA256,
      undefined,
      this.transferTimeoutMs,
    );
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of res.body) {
      bytes += chunk.length;
      hash.update(chunk);
    }
    return { bytes, sha256: hash.digest('hex') };
  }

  async deleteObject(key: string): Promise<void> {
    const res = await this.send('DeleteObject', 'DELETE', key, {}, {}, EMPTY_SHA256);
    await drain(res.body);
  }

  /** Every object under `prefix`, following ListObjects markers. */
  async listObjects(prefix: string): Promise<readonly StoredObject[]> {
    const out: StoredObject[] = [];
    let marker: string | null = null;
    for (let page = 0; page < 1000; page += 1) {
      const query: Record<string, string> = { prefix };
      if (marker !== null) query['marker'] = marker;
      const res = await this.send('ListObjects', 'GET', '', query, {}, EMPTY_SHA256);
      const parsed = parseListObjects(await readAll(res.body));
      out.push(...parsed.objects);
      if (!parsed.truncated) return out;
      marker = parsed.nextMarker ?? parsed.objects.at(-1)?.key ?? null;
      if (marker === null) return out;
    }
    throw new Error('object store ListObjects did not finish after 1000 pages');
  }

  private async send(
    operation: string,
    method: HttpRequest['method'],
    key: string,
    query: Readonly<Record<string, string>>,
    extraHeaders: Readonly<Record<string, string>>,
    payloadSha256: string,
    body?: () => Readable,
    timeoutMs = this.callTimeoutMs,
  ): Promise<HttpResponse> {
    const at = this.now();
    const base = this.config.endpoint;
    const path = `${base.pathname.replace(/\/+$/u, '')}/${this.config.bucket}${key === '' ? '' : `/${key}`}`;
    const headers: Record<string, string> = {
      host: base.host,
      'x-amz-date': amzDate(at),
      'x-amz-content-sha256': payloadSha256,
      ...extraHeaders,
    };
    headers['authorization'] = authorization(
      { method, path, query, headers, payloadSha256 },
      this.config.credentials,
      this.config.region,
      's3',
      at,
    );
    const search = canonicalQuery(query);
    const url = new URL(
      `${base.origin}${uriEncode(path, true)}${search === '' ? '' : `?${search}`}`,
    );
    const res = await this.transport({
      method,
      url,
      headers,
      ...(body === undefined ? {} : { body }),
      timeoutMs,
    });
    if (res.status >= 200 && res.status < 300) return res;
    let code: string | null = null;
    try {
      code = tag(await readAll(res.body, 64 * 1024), 'Code');
    } catch {
      // The status alone is the answer.
    }
    throw new ObjectStoreError(operation, res.status, code);
  }
}
