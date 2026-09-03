import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MissingPartError,
  MultipartUploadMismatchError,
  MultipartUploadNotFoundError,
  PartEtagMismatchError,
  PartTooLargeError,
  UnsafeObjectPathError,
} from './errors.js';
import { FilesystemObjectStore } from './filesystem-object-store.js';
import { uploadObjectKey } from './object-key.js';

const ORG = '019203a4-5b6c-7d8e-9f01-23456789abcd';
const PROJECT = '019203a4-5b6c-7d8e-9f01-23456789abce';
const UPLOAD = '019203a4-5b6c-7d8e-9f01-23456789abcf';
const KEY = uploadObjectKey({ organizationId: ORG, projectId: PROJECT, uploadId: UPLOAD });
const SECRET = 'a_signing_secret_that_is_long_enough_for_the_suite';
const PUBLIC_URL = 'http://api.test:4000';
const PART_SIZE = 16;

let root: string;
let clock: number;
let store: FilesystemObjectStore;

const md5 = (bytes: Buffer) => createHash('md5').update(bytes).digest('hex');
const bytes = (fill: string, length = PART_SIZE) => Buffer.alloc(length, fill);

/** The handle and the part tokens, read back the way a browser would: from the URLs. */
function targets(upload: { providerUploadId: string; parts: readonly { url: string }[] }) {
  return upload.parts.map((part) => {
    const url = new URL(part.url);
    const [, , , providerUploadId, , partNumber] = url.pathname.split('/');
    return {
      providerUploadId: providerUploadId as string,
      partNumber: Number(partNumber),
      token: url.searchParams.get('t') ?? undefined,
    };
  });
}

async function begin(partCount = 2, zone: 'quarantine' | 'private' = 'quarantine') {
  return store.beginMultipart({ zone, objectKey: KEY, partCount, expiresInSeconds: 900 });
}

function walk(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(root.length + 1)
        .replace(/\\/g, '/'),
    );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tmanage-storage-'));
  clock = 1_800_000_000_000;
  store = new FilesystemObjectStore({
    root,
    signingSecret: SECRET,
    publicUrl: `${PUBLIC_URL}/`,
    partSizeBytes: PART_SIZE,
    now: () => clock,
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('FilesystemObjectStore — the whole upload', () => {
  it('assembles the parts in order, reports the true size and the S3 composite etag, and clears the staging directory', async () => {
    const upload = await begin(2);
    const [one, two] = targets(upload) as [
      ReturnType<typeof targets>[number],
      ReturnType<typeof targets>[number],
    ];
    // Out of order on purpose, and the last part shorter than the part size.
    const secondBytes = bytes('b', 5);
    const firstBytes = bytes('a');
    const second = await store.putPart({ ...two, body: secondBytes });
    const first = await store.putPart({ ...one, body: firstBytes });
    expect(first?.etag).toBe(md5(firstBytes));
    expect(second?.etag).toBe(md5(secondBytes));

    const stored = await store.completeMultipart({
      zone: 'quarantine',
      objectKey: KEY,
      providerUploadId: upload.providerUploadId,
      parts: [
        { partNumber: 2, etag: `"${second?.etag?.toUpperCase()}"` }, // quoted, upper-cased: S3's habits
        { partNumber: 1, etag: first?.etag ?? '' },
      ],
    });
    expect(stored.sizeBytes).toBe(PART_SIZE + 5);
    const composite = createHash('md5')
      .update(
        Buffer.concat([Buffer.from(md5(firstBytes), 'hex'), Buffer.from(md5(secondBytes), 'hex')]),
      )
      .digest('hex');
    expect(stored.etag).toBe(`${composite}-2`);

    const objectPath = store.objectPath('quarantine', KEY);
    expect(readFileSync(objectPath)).toEqual(Buffer.concat([firstBytes, secondBytes]));
    expect(walk(root)).toEqual([`objects/quarantine/${KEY}`]);
    // Reversal: skip the `rm` of the staging directory and `uploads/<handle>/…` is still here.
  });

  it('mints URLs that carry the handle and a token, and never the key, the tenant or the project', async () => {
    const upload = await begin(3);
    expect(upload.providerUploadId).toMatch(/^[0-9a-f]{32}$/);
    expect(upload.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    for (const part of upload.parts) {
      expect(
        part.url.startsWith(`${PUBLIC_URL}/v1/uploads/${upload.providerUploadId}/parts/`),
      ).toBe(true);
      expect(part.url).not.toContain(ORG);
      expect(part.url).not.toContain(PROJECT);
      expect(part.url).not.toContain('tenant');
    }
    expect(new Set(upload.parts.map((p) => p.url)).size).toBe(3);
  });

  it('replaces a part that is PUT twice, so a retry is a retry', async () => {
    const upload = await begin(1);
    const [one] = targets(upload);
    await store.putPart({ ...(one as NonNullable<typeof one>), body: bytes('x') });
    const again = await store.putPart({ ...(one as NonNullable<typeof one>), body: bytes('y') });
    const stored = await store.completeMultipart({
      zone: 'quarantine',
      objectKey: KEY,
      providerUploadId: upload.providerUploadId,
      parts: [{ partNumber: 1, etag: again?.etag ?? '' }],
    });
    expect(stored.sizeBytes).toBe(PART_SIZE);
    expect(readFileSync(store.objectPath('quarantine', KEY))).toEqual(bytes('y'));
  });
});

describe('FilesystemObjectStore — what completion refuses', () => {
  it('refuses a missing part and an etag that does not match, and writes no object either way', async () => {
    const upload = await begin(2);
    const [one] = targets(upload);
    const first = await store.putPart({ ...(one as NonNullable<typeof one>), body: bytes('a') });
    const complete = (parts: { partNumber: number; etag: string }[]) =>
      store.completeMultipart({
        zone: 'quarantine',
        objectKey: KEY,
        providerUploadId: upload.providerUploadId,
        parts,
      });

    await expect(
      complete([
        { partNumber: 1, etag: first?.etag ?? '' },
        { partNumber: 2, etag: 'anything' },
      ]),
    ).rejects.toBeInstanceOf(MissingPartError);
    // Reversal: compare the etags to nothing and a wrong etag completes.
    await expect(
      complete([
        { partNumber: 1, etag: md5(bytes('z')) },
        { partNumber: 2, etag: 'anything' },
      ]),
    ).rejects.toBeInstanceOf(PartEtagMismatchError);
    expect(existsSync(store.objectPath('quarantine', KEY))).toBe(false);
    // The upload is still open: nothing about a refused completion abandons it.
    expect(existsSync(join(root, 'uploads', upload.providerUploadId, 'manifest.json'))).toBe(true);
  });

  it('refuses a zone or key that is not the one the upload was opened under', async () => {
    const upload = await begin(1);
    await expect(
      store.completeMultipart({
        zone: 'private',
        objectKey: KEY,
        providerUploadId: upload.providerUploadId,
        parts: [],
      }),
    ).rejects.toBeInstanceOf(MultipartUploadMismatchError);
  });
});

describe('FilesystemObjectStore — the directory is the revocation', () => {
  it('abort is idempotent, and after it the PUT and the completion are both refused', async () => {
    const upload = await begin(1);
    const [one] = targets(upload);
    const abort = () =>
      store.abortMultipart({
        zone: 'quarantine',
        objectKey: KEY,
        providerUploadId: upload.providerUploadId,
      });
    await abort();
    await abort(); // Reversal: `rm` without `force` and the second abort throws ENOENT.
    await store.abortMultipart({
      zone: 'quarantine',
      objectKey: KEY,
      providerUploadId: 'f'.repeat(32),
    });

    // Reversal: carry `partCount` in the token instead of a manifest and this PUT succeeds —
    // the URL is still valid for another fourteen minutes and nothing on disk says otherwise.
    expect(
      await store.putPart({ ...(one as NonNullable<typeof one>), body: bytes('a') }),
    ).toBeNull();
    await expect(
      store.completeMultipart({
        zone: 'quarantine',
        objectKey: KEY,
        providerUploadId: upload.providerUploadId,
        parts: [{ partNumber: 1, etag: md5(bytes('a')) }],
      }),
    ).rejects.toBeInstanceOf(MultipartUploadNotFoundError);
    expect(walk(root)).toEqual([]);
  });

  it('refuses a PUT after completion, and the object is untouched', async () => {
    const upload = await begin(1);
    const [one] = targets(upload);
    const first = await store.putPart({ ...(one as NonNullable<typeof one>), body: bytes('a') });
    await store.completeMultipart({
      zone: 'quarantine',
      objectKey: KEY,
      providerUploadId: upload.providerUploadId,
      parts: [{ partNumber: 1, etag: first?.etag ?? '' }],
    });
    const before = statSync(store.objectPath('quarantine', KEY));
    expect(
      await store.putPart({ ...(one as NonNullable<typeof one>), body: bytes('z') }),
    ).toBeNull();
    expect(readFileSync(store.objectPath('quarantine', KEY))).toEqual(bytes('a'));
    expect(statSync(store.objectPath('quarantine', KEY)).size).toBe(before.size);
  });
});

describe('FilesystemObjectStore — what the PUT refuses', () => {
  it('refuses a forged, foreign, expired or out-of-range part with one null, and writes nothing', async () => {
    const upload = await begin(2);
    const other = await begin(2);
    const [one, two] = targets(upload);
    const [otherOne] = targets(other);
    const valid = one as NonNullable<typeof one>;

    expect(await store.putPart({ ...valid, token: undefined, body: bytes('a') })).toBeNull();
    expect(
      await store.putPart({ ...valid, token: `${valid.token}x`, body: bytes('a') }),
    ).toBeNull();
    // Another upload's token for the same part number.
    expect(
      await store.putPart({
        ...valid,
        token: (otherOne as NonNullable<typeof otherOne>).token,
        body: bytes('a'),
      }),
    ).toBeNull();
    // This upload's token for the other part.
    expect(
      await store.putPart({
        ...valid,
        token: (two as NonNullable<typeof two>).token,
        body: bytes('a'),
      }),
    ).toBeNull();
    // A part number the upload does not have, with a token minted for it by hand is impossible;
    // a valid token for part 1 presented against part 3 is a mismatch.
    expect(await store.putPart({ ...valid, partNumber: 3, body: bytes('a') })).toBeNull();
    // A traversal attempt in the handle.
    expect(
      await store.putPart({ ...valid, providerUploadId: '../../etc/passwd', body: bytes('a') }),
    ).toBeNull();

    clock += 900_001;
    expect(await store.putPart({ ...valid, body: bytes('a') })).toBeNull();

    expect(walk(root)).toEqual(
      [
        `uploads/${other.providerUploadId}/manifest.json`,
        `uploads/${upload.providerUploadId}/manifest.json`,
      ].sort(),
    );
  });

  it('refuses a body over the part size, after the token, and writes nothing', async () => {
    const upload = await begin(1);
    const [one] = targets(upload);
    const valid = one as NonNullable<typeof one>;
    await expect(
      store.putPart({ ...valid, body: bytes('a', PART_SIZE + 1) }),
    ).rejects.toBeInstanceOf(PartTooLargeError);
    // Over the size *and* forged: the refusal is the token's, not the size's.
    expect(
      await store.putPart({ ...valid, token: 'pu1.1.x', body: bytes('a', PART_SIZE + 1) }),
    ).toBeNull();
    expect(walk(root)).toEqual([`uploads/${upload.providerUploadId}/manifest.json`]);
  });
});

describe('FilesystemObjectStore — paths', () => {
  it('refuses a key that would leave the zone, before anything is written', async () => {
    for (const objectKey of [
      '../../etc/passwd',
      'tenant/../../x',
      'tenant//x',
      'a\\b',
      'C:/x',
      '',
      `${KEY}/../escape`,
    ]) {
      await expect(
        store.beginMultipart({ zone: 'quarantine', objectKey, partCount: 1, expiresInSeconds: 60 }),
      ).rejects.toBeInstanceOf(UnsafeObjectPathError);
    }
    expect(() => store.objectPath('nowhere' as 'quarantine', KEY)).toThrow(UnsafeObjectPathError);
    expect(walk(root)).toEqual([]);
  });

  it('keeps the zones apart', async () => {
    const upload = await begin(1, 'private');
    const [one] = targets(upload);
    const first = await store.putPart({ ...(one as NonNullable<typeof one>), body: bytes('a') });
    await store.completeMultipart({
      zone: 'private',
      objectKey: KEY,
      providerUploadId: upload.providerUploadId,
      parts: [{ partNumber: 1, etag: first?.etag ?? '' }],
    });
    expect(walk(root)).toEqual([`objects/private/${KEY}`]);
    expect(existsSync(store.objectPath('quarantine', KEY))).toBe(false);
  });
});
