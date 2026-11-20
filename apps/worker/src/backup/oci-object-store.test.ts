import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OciObjectStore, ObjectStoreError, parseListObjects } from './oci-object-store.js';
import type { HttpRequest, HttpResponse, HttpTransport } from './oci-object-store.js';

const ENDPOINT = new URL(
  'https://axaxnpcrorw5.compat.objectstorage.ca-montreal-1.oci.customer-oci.com',
);
const AT = new Date('2026-11-20T03:00:00Z');

function reply(status: number, body = '', headers: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers,
    body: (async function* () {
      yield Buffer.from(body);
    })(),
  };
}

function recorder(answer: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>): {
  readonly transport: HttpTransport;
  readonly sent: { req: HttpRequest; body: Buffer | null }[];
} {
  const sent: { req: HttpRequest; body: Buffer | null }[] = [];
  return {
    sent,
    transport: async (req) => {
      sent.push({ req, body: req.body === undefined ? null : await buffer(req.body()) });
      return answer(req);
    },
  };
}

const store = (transport: HttpTransport): OciObjectStore =>
  new OciObjectStore({
    endpoint: ENDPOINT,
    region: 'ca-montreal-1',
    bucket: 'tmanage-db-backups',
    credentials: { accessKeyId: 'ocid-key-id', secretAccessKey: 'super-secret-value' },
    transport,
    now: () => AT,
  });

let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oci-store-test-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('OciObjectStore', () => {
  it('PUTs path-style with the body hash signed and Content-MD5 and Content-Length set', async () => {
    const body = Buffer.from('ciphertext bytes');
    const path = join(dir, 'db.sql.gz.age');
    await writeFile(path, body);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const md5Base64 = createHash('md5').update(body).digest('base64');
    const r = recorder(() => reply(200));
    await store(r.transport).putObject(
      'db/20261120T030000Z/db.sql.gz.age',
      { path, bytes: body.length, sha256, md5Base64 },
      'application/octet-stream',
    );
    const [{ req, body: sentBody } = { req: null, body: null }] = r.sent;
    expect(req?.method).toBe('PUT');
    expect(req?.url.href).toBe(
      `${ENDPOINT.origin}/tmanage-db-backups/db/20261120T030000Z/db.sql.gz.age`,
    );
    expect(req?.headers['x-amz-content-sha256']).toBe(sha256);
    expect(req?.headers['content-md5']).toBe(md5Base64);
    expect(req?.headers['content-length']).toBe(String(body.length));
    expect(req?.headers['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=ocid-key-id\/20261120\/ca-montreal-1\/s3\/aws4_request, SignedHeaders=content-length;content-md5;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/u,
    );
    expect(sentBody?.equals(body)).toBe(true);
  });

  it('reads an object back and hashes it', async () => {
    const r = recorder(() => reply(200, 'stored'));
    const digest = await store(r.transport).digestObject('db/x/manifest.json');
    expect(digest).toEqual({
      bytes: 6,
      sha256: createHash('sha256').update('stored').digest('hex'),
    });
  });

  it('lists with ListObjects v1, following the marker of a truncated page', async () => {
    const pages = [
      '<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>db/a/manifest.json</Key><Size>10</Size></Contents></ListBucketResult>',
      '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>db/b/x&amp;y</Key><Size>5</Size></Contents></ListBucketResult>',
    ];
    const r = recorder(() => reply(200, pages.shift() ?? ''));
    expect(await store(r.transport).listObjects('db/')).toEqual([
      { key: 'db/a/manifest.json', size: 10 },
      { key: 'db/b/x&y', size: 5 },
    ]);
    expect(r.sent.map((s) => s.req.url.search)).toEqual([
      '?prefix=db%2F',
      '?marker=db%2Fa%2Fmanifest.json&prefix=db%2F',
    ]);
    expect(r.sent.every((s) => !s.req.url.search.includes('list-type'))).toBe(true);
  });

  it('turns an error answer into the status and S3 code, without any credential', async () => {
    const r = recorder(() =>
      reply(403, '<Error><Code>SignatureDoesNotMatch</Code><Message>no</Message></Error>'),
    );
    const failure = await store(r.transport)
      .deleteObject('db/x/y')
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ObjectStoreError);
    const message = (failure as Error).message;
    expect(message).toBe('object store DeleteObject -> 403 SignatureDoesNotMatch');
    expect(message).not.toContain('super-secret-value');
    expect(message).not.toContain('ocid-key-id');
  });

  it('parses an empty listing', () => {
    expect(
      parseListObjects('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>'),
    ).toEqual({
      objects: [],
      truncated: false,
      nextMarker: null,
    });
  });
});
