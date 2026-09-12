import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MissingPartError,
  MultipartUploadMismatchError,
  MultipartUploadNotFoundError,
  ObjectNotFoundError,
  PartEtagMismatchError,
  PartTooLargeError,
  PromotionClosedError,
  SizeMismatchError,
  UnsafeObjectPathError,
} from './errors.js';
import { FilesystemObjectStore } from './filesystem-object-store.js';
import { uploadObjectKey } from './object-key.js';
import { derivePartSigningKey, mintPartToken } from './part-token.js';

const ORG = '019203a4-5b6c-7d8e-9f01-23456789abcd';
const PROJECT = '019203a4-5b6c-7d8e-9f01-23456789abce';
const UPLOAD = '019203a4-5b6c-7d8e-9f01-23456789abcf';
const KEY = uploadObjectKey({ organizationId: ORG, projectId: PROJECT, uploadId: UPLOAD });
const OTHER_KEY = uploadObjectKey({
  organizationId: ORG,
  projectId: PROJECT,
  uploadId: '019203a4-5b6c-7d8e-9f01-23456789abd0',
});
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

async function begin(
  partCount = 2,
  zone: 'quarantine' | 'private' = 'quarantine',
  declaredBytes = partCount * PART_SIZE,
) {
  return store.beginMultipart({
    zone,
    objectKey: KEY,
    partCount,
    declaredBytes,
    expiresInSeconds: 900,
  });
}

function walk(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(root.length + 1)
        .replace(/\\/g, '/'),
    )
    .sort();
}

/** The one platform restriction that may excuse the symbolic-link case; nothing else may. */
const SKIPPABLE_SYMLINK_CODES = new Set(['EPERM', 'EACCES']);

type SymlinkSupport = { supported: true } | { supported: false; code: string };

let symlinkSupportProbe: SymlinkSupport | undefined;

/**
 * Can this process create a symbolic link at all?
 *
 * Windows without `SeCreateSymbolicLinkPrivilege` answers EPERM (EACCES under some policies), and
 * that is the only reason the symbolic-link case below may be skipped. Any other failure is a
 * fixture defect and is rethrown here: swallowing it is how a security case reported passed for
 * months without asserting anything (production review of 2026-09-05, D17).
 *
 * Only `symlinkSync` is watched for a skippable code. Writing the probe's target happens outside
 * that `try` on purpose: antivirus or a locked-down temp directory can answer EPERM/EACCES to the
 * *write*, which says nothing about symbolic links, and folding it in here would have the skip
 * note below blame a missing symbolic-link privilege that the runner may well hold. A write that
 * fails now throws out of this probe naming `writeFileSync`, and the case fails as the fixture
 * defect it is.
 */
function symlinkSupport(): SymlinkSupport {
  if (symlinkSupportProbe) return symlinkSupportProbe;
  const probe = mkdtempSync(join(tmpdir(), 'tmanage-symlink-probe-'));
  try {
    const target = join(probe, 'target');
    writeFileSync(target, 'probe');
    try {
      symlinkSync(target, join(probe, 'link'), 'file');
      symlinkSupportProbe = { supported: true };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!SKIPPABLE_SYMLINK_CODES.has(code)) throw error;
      symlinkSupportProbe = { supported: false, code };
    }
  } finally {
    rmSync(probe, { recursive: true, force: true, maxRetries: 3 });
  }
  return symlinkSupportProbe;
}

/**
 * May the symbolic-link case skip when the platform cannot build its fixture?
 *
 * `TMANAGE_REQUIRE_SYMLINK_CASE=1` forbids the skip: an environment that cannot create a symbolic
 * link fails the case instead. The skip is forbidden by default everywhere except Windows, because
 * on Linux and macOS an ordinary temp directory takes a symbolic link — so a release runner cannot
 * let this case skip unnoticed even when nothing sets the variable. Where it cannot (a FAT or
 * exFAT temp mount, a hardened container), that runner fails the case rather than skipping it,
 * which is the outcome we want: the guard is unproven there and says so. `=0` permits the skip
 * anywhere, for a deliberately unprivileged run.
 *
 * Any set value other than `0` means "required". Chosen over rejecting unrecognised values because
 * the old strict `'1'`/`'0'` comparison failed silently and in the wrong direction: `=true` looked
 * like it had made the case mandatory and quietly handed back the platform default instead. Only
 * the explicit opt-out permits a skip; anything else errs towards proving the guard. An unset or
 * empty variable is not a value and still falls through to the platform default.
 */
function symlinkCaseIsRequired(): boolean {
  const flag = process.env['TMANAGE_REQUIRE_SYMLINK_CASE'];
  if (flag !== undefined && flag !== '') return flag !== '0';
  return process.platform !== 'win32';
}

/**
 * The preamble every symbolic-link case shares: return once the fixture can be built, and
 * otherwise fail or skip saying so. Two guards stand on `lstat` — `openObject`'s and
 * `withdraw`'s — and each has a case here; neither may quietly report passed on a runner that
 * could not build the link, which is exactly what the `openObject` case did for months (D17).
 *
 * `guard` names what the calling case would have proved, so two skipped lines cannot be told
 * apart only by their line number. Three outcomes and no fourth: anything the probe did not
 * predict it rethrows itself, a runner required to build the fixture and unable to fails, and an
 * unprivileged one skips in the open naming the platform and the code.
 */
function requireSymlinkFixture(ctx: { skip: (note: string) => void }, guard: string): void {
  const support = symlinkSupport();
  if (support.supported) return;
  if (symlinkCaseIsRequired()) {
    throw new Error(
      `This runner must be able to create a symbolic link and cannot: symlinkSync answered ` +
        `${support.code} on ${process.platform}. The lstat guard of ${guard} is ` +
        `unproven without it. Run the storage suite where symbolic links can be created, or ` +
        `set TMANAGE_REQUIRE_SYMLINK_CASE=0 to accept the gap deliberately.`,
    );
  }
  ctx.skip(
    `${process.platform} without the symbolic-link privilege (symlinkSync: ${support.code}): ` +
      `the fixture cannot be built here, so the lstat guard of ${guard} is NOT proved on this ` +
      `run. Set TMANAGE_REQUIRE_SYMLINK_CASE=1 to turn this skip into a failure.`,
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
    const upload = await begin(2, 'quarantine', PART_SIZE + 5);
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
    // Reversal: compare the zone alone and another key under the right zone completes.
    await expect(
      store.completeMultipart({
        zone: 'quarantine',
        objectKey: OTHER_KEY,
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
        store.beginMultipart({
          zone: 'quarantine',
          objectKey,
          partCount: 1,
          declaredBytes: PART_SIZE,
          expiresInSeconds: 60,
        }),
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

describe('FilesystemObjectStore — the fleet’s findings (FILE-001b review)', () => {
  const key = () => derivePartSigningKey(SECRET);

  it('refuses, by the manifest alone, a hand-minted token for a part the upload does not have', async () => {
    // The minted URLs cannot reach this branch: their tokens are for parts that exist. A
    // token signed with the real key for part 3 of a two-part upload verifies, and the
    // manifest is what refuses it. Reversal: drop the range check and part-0003 is written.
    const upload = await begin(2);
    const token = mintPartToken(key(), {
      providerUploadId: upload.providerUploadId,
      partNumber: 3,
      expiresAtMs: clock + 900_000,
    });
    expect(
      await store.putPart({
        providerUploadId: upload.providerUploadId,
        partNumber: 3,
        token,
        body: bytes('a'),
      }),
    ).toBeNull();
    expect(walk(root)).toEqual([`uploads/${upload.providerUploadId}/manifest.json`]);
  });

  it('refuses, by the manifest alone, a hand-minted token that outlives the manifest', async () => {
    // The token carries the manifest's expiry, so the minted URLs cannot reach this branch
    // either. One signed for a later expiry still verifies once the manifest has lapsed;
    // the manifest refuses it. Reversal: drop the manifest expiry check and the PUT lands.
    const upload = await begin(1);
    const token = mintPartToken(key(), {
      providerUploadId: upload.providerUploadId,
      partNumber: 1,
      expiresAtMs: clock + 2_000_000,
    });
    clock += 1_000_000;
    expect(
      await store.putPart({
        providerUploadId: upload.providerUploadId,
        partNumber: 1,
        token,
        body: bytes('a'),
      }),
    ).toBeNull();
    expect(walk(root)).toEqual([`uploads/${upload.providerUploadId}/manifest.json`]);
  });

  it('judges a part by the size the upload was opened at, not by the process’s current one', async () => {
    // Reversal: read the ceiling from the store instead of the manifest and the wider
    // store accepts seventeen bytes for an upload whose URLs were minted at sixteen.
    const upload = await begin(1);
    const [one] = targets(upload);
    const valid = one as NonNullable<typeof one>;
    const wider = new FilesystemObjectStore({
      root,
      signingSecret: SECRET,
      publicUrl: PUBLIC_URL,
      partSizeBytes: PART_SIZE * 2,
      now: () => clock,
    });
    await expect(
      wider.putPart({ ...valid, body: bytes('a', PART_SIZE + 1) }),
    ).rejects.toBeInstanceOf(PartTooLargeError);
    const narrower = new FilesystemObjectStore({
      root,
      signingSecret: SECRET,
      publicUrl: PUBLIC_URL,
      partSizeBytes: PART_SIZE / 2,
      now: () => clock,
    });
    expect((await narrower.putPart({ ...valid, body: bytes('a') }))?.etag).toBe(md5(bytes('a')));
  });

  it('refuses to complete an upload past the manifest’s expiry, as one the store no longer holds', async () => {
    // Reversal: skip the expiry at completion and the object is written.
    const upload = await begin(1);
    const [one] = targets(upload);
    const first = await store.putPart({ ...(one as NonNullable<typeof one>), body: bytes('a') });
    clock += 900_001;
    await expect(
      store.completeMultipart({
        zone: 'quarantine',
        objectKey: KEY,
        providerUploadId: upload.providerUploadId,
        parts: [{ partNumber: 1, etag: first?.etag ?? '' }],
      }),
    ).rejects.toBeInstanceOf(MultipartUploadNotFoundError);
    expect(existsSync(store.objectPath('quarantine', KEY))).toBe(false);
  });

  it('abort refuses a zone or key that is not the one the upload was opened under, and deletes nothing', async () => {
    // The one path whose failure mode is silent deletion does not act on the handle alone.
    // Reversal: delete on the handle and the wrong zone removes the upload.
    const upload = await begin(1);
    const manifest = join(root, 'uploads', upload.providerUploadId, 'manifest.json');
    await expect(
      store.abortMultipart({
        zone: 'private',
        objectKey: KEY,
        providerUploadId: upload.providerUploadId,
      }),
    ).rejects.toBeInstanceOf(MultipartUploadMismatchError);
    await expect(
      store.abortMultipart({
        zone: 'quarantine',
        objectKey: OTHER_KEY,
        providerUploadId: upload.providerUploadId,
      }),
    ).rejects.toBeInstanceOf(MultipartUploadMismatchError);
    expect(existsSync(manifest)).toBe(true);
    await store.abortMultipart({
      zone: 'quarantine',
      objectKey: KEY,
      providerUploadId: upload.providerUploadId,
    });
    expect(existsSync(manifest)).toBe(false);
  });

  it('leaves nothing behind when a part cannot be written into place', async () => {
    // A directory squatting on the part's name makes the final rename fail. The temporary
    // file the driver wrote beside it must go with the failure. Reversal: drop the cleanup
    // and a `part-0001.<suffix>.tmp` stays under the upload.
    const upload = await begin(1);
    const [one] = targets(upload);
    mkdirSync(join(root, 'uploads', upload.providerUploadId, 'part-0001'));
    await expect(
      store.putPart({ ...(one as NonNullable<typeof one>), body: bytes('a') }),
    ).rejects.toThrow();
    expect(walk(root)).toEqual([`uploads/${upload.providerUploadId}/manifest.json`]);
  });

  it('lets two PUTs of the same part land whole, each answered with the etag of what it sent', async () => {
    // A client retrying into its own earlier attempt. Reversal: one deterministic `.tmp`
    // name and the two writers share a file — one rename finds nothing to move, or the
    // bytes on disk are neither body.
    const upload = await begin(1);
    const [one] = targets(upload);
    const valid = one as NonNullable<typeof one>;
    const [x, y] = await Promise.all([
      store.putPart({ ...valid, body: bytes('x') }),
      store.putPart({ ...valid, body: bytes('y') }),
    ]);
    expect(x?.etag).toBe(md5(bytes('x')));
    expect(y?.etag).toBe(md5(bytes('y')));
    const landed = readFileSync(join(root, 'uploads', upload.providerUploadId, 'part-0001'));
    expect([bytes('x'), bytes('y')].some((body) => body.equals(landed))).toBe(true);
    expect(walk(root)).toEqual([
      `uploads/${upload.providerUploadId}/manifest.json`,
      `uploads/${upload.providerUploadId}/part-0001`,
    ]);
  });

  it('discards the staging file of a refused completion, keeps the parts, and completes on the second try', async () => {
    // Completion is one pass: part 1 is already in the staging file when part 2's etag is
    // found wrong. The staging file must go and the parts must stay, so the client can
    // re-PUT and complete again (decision 11). Reversal: skip the discard and an
    // `object.<suffix>.tmp` sits beside the parts.
    const upload = await begin(2);
    const [one, two] = targets(upload);
    const first = await store.putPart({ ...(one as NonNullable<typeof one>), body: bytes('a') });
    const second = await store.putPart({ ...(two as NonNullable<typeof two>), body: bytes('b') });
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
        { partNumber: 2, etag: md5(bytes('z')) },
      ]),
    ).rejects.toBeInstanceOf(PartEtagMismatchError);
    expect(walk(root)).toEqual([
      `uploads/${upload.providerUploadId}/manifest.json`,
      `uploads/${upload.providerUploadId}/part-0001`,
      `uploads/${upload.providerUploadId}/part-0002`,
    ]);
    const stored = await complete([
      { partNumber: 1, etag: first?.etag ?? '' },
      { partNumber: 2, etag: second?.etag ?? '' },
    ]);
    expect(stored.sizeBytes).toBe(PART_SIZE * 2);
    expect(readFileSync(store.objectPath('quarantine', KEY))).toEqual(
      Buffer.concat([bytes('a'), bytes('b')]),
    );
    expect(walk(root)).toEqual([`objects/quarantine/${KEY}`]);
  });
});

describe('FilesystemObjectStore — the security review (2026-09-04)', () => {
  it('refuses a completion whose bytes do not add up to the declaration before any object exists, and keeps the parts', async () => {
    // Declared two full parts; the second arrives short. Before the review the object was
    // written, then the size reported, and the mismatch left a real file behind that no
    // reservation covered and nothing could delete.
    const upload = await begin(2);
    const [one, two] = targets(upload) as [
      ReturnType<typeof targets>[number],
      ReturnType<typeof targets>[number],
    ];
    const first = await store.putPart({ ...one, body: bytes('a') });
    const second = await store.putPart({ ...two, body: bytes('b', 5) });
    await expect(
      store.completeMultipart({
        zone: 'quarantine',
        objectKey: KEY,
        providerUploadId: upload.providerUploadId,
        parts: [
          { partNumber: 1, etag: first?.etag ?? '' },
          { partNumber: 2, etag: second?.etag ?? '' },
        ],
      }),
    ).rejects.toMatchObject({ name: 'SizeMismatchError', declaredBytes: 2 * PART_SIZE });
    // Reversal: move the check after `rename` and `objects/quarantine/<key>` appears here.
    expect(walk(root)).toEqual(
      [
        `uploads/${upload.providerUploadId}/manifest.json`,
        `uploads/${upload.providerUploadId}/part-0001`,
        `uploads/${upload.providerUploadId}/part-0002`,
      ].sort(),
    );
  });

  it('holds a part to what the declaration leaves for it: a one-byte upload cannot land a full part', async () => {
    const upload = await begin(1, 'quarantine', 1);
    const [one] = targets(upload);
    const valid = one as NonNullable<typeof one>;
    // Reversal: judge the body by `partSizeBytes` alone and sixteen bytes land on disk.
    await expect(store.putPart({ ...valid, body: bytes('a', 2) })).rejects.toMatchObject({
      name: 'PartTooLargeError',
      maxBytes: 1,
    });
    expect(walk(root)).toEqual([`uploads/${upload.providerUploadId}/manifest.json`]);
    expect((await store.putPart({ ...valid, body: bytes('a', 1) }))?.etag).toBe(md5(bytes('a', 1)));
  });

  it('caps the last part at the remainder, and the parts before it at the part size', async () => {
    const upload = await begin(2, 'quarantine', PART_SIZE + 3);
    const [one, two] = targets(upload) as [
      ReturnType<typeof targets>[number],
      ReturnType<typeof targets>[number],
    ];
    expect(await store.putPart({ ...one, body: bytes('a') })).not.toBeNull();
    await expect(store.putPart({ ...two, body: bytes('b', 4) })).rejects.toMatchObject({
      maxBytes: 3,
    });
    expect(await store.putPart({ ...two, body: bytes('b', 3) })).not.toBeNull();
  });
});

describe('FilesystemObjectStore — openObject (FILE-002)', () => {
  /** Complete a two-part upload under KEY and return the bytes the object holds. */
  async function seal(zone: 'quarantine' | 'private' = 'quarantine'): Promise<Buffer> {
    const upload = await begin(2, zone);
    const [one, two] = targets(upload) as [
      ReturnType<typeof targets>[number],
      ReturnType<typeof targets>[number],
    ];
    const first = await store.putPart({ ...one, body: bytes('a') });
    const second = await store.putPart({ ...two, body: bytes('b') });
    await store.completeMultipart({
      zone,
      objectKey: KEY,
      providerUploadId: upload.providerUploadId,
      parts: [
        { partNumber: 1, etag: first?.etag ?? '' },
        { partNumber: 2, etag: second?.etag ?? '' },
      ],
    });
    return Buffer.concat([bytes('a'), bytes('b')]);
  }

  async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  it('streams the sealed object with the size it holds now', async () => {
    const expected = await seal();
    const opened = await store.openObject({ zone: 'quarantine', objectKey: KEY });
    expect(opened.sizeBytes).toBe(2 * PART_SIZE);
    expect(await drain(opened.stream)).toEqual(expected);
  });

  it('answers not-found for a key nothing was sealed under, and for the same key in another zone', async () => {
    await seal('quarantine');
    await expect(store.openObject({ zone: 'private', objectKey: KEY })).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
    await expect(
      store.openObject({ zone: 'quarantine', objectKey: OTHER_KEY }),
    ).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it('refuses a symbolic link left under the root, so a read can never leave the store', async (ctx) => {
    // Something outside this driver put a link where an object should be. `lstat` sees
    // the link; `stat` would have followed it and hashed the secret.
    //
    // Three outcomes where there used to be one silent pass: a runner that is required to build
    // this fixture and cannot, fails; an unprivileged runner skips in the open, naming the code;
    // anything the probe did not predict is rethrown by the probe itself.
    requireSymlinkFixture(ctx, 'openObject (FILE-002)');
    const secret = join(root, 'secret.txt');
    writeFileSync(secret, 'not an object');
    const path = store.objectPath('quarantine', OTHER_KEY);
    mkdirSync(dirname(path), { recursive: true });
    // Any error from here is a fixture defect: it fails the case. Nothing is swallowed.
    symlinkSync(secret, path, 'file');
    // Reversal: `stat` instead of `lstat` and this resolves with the secret's thirteen bytes.
    await expect(
      store.openObject({ zone: 'quarantine', objectKey: OTHER_KEY }),
    ).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it('refuses a directory at the object path as not an object', async () => {
    mkdirSync(store.objectPath('quarantine', OTHER_KEY), { recursive: true });
    await expect(
      store.openObject({ zone: 'quarantine', objectKey: OTHER_KEY }),
    ).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it('checks the key before it touches the disk', async () => {
    await expect(
      store.openObject({ zone: 'quarantine', objectKey: '../../etc/passwd' }),
    ).rejects.toBeInstanceOf(UnsafeObjectPathError);
  });
});

describe('FilesystemObjectStore — promote and withdraw (FILE-002 slice B)', () => {
  /** Complete a two-part upload under KEY in quarantine and return the bytes it holds. */
  async function seal(): Promise<Buffer> {
    const upload = await begin(2, 'quarantine');
    const [one, two] = targets(upload) as [
      ReturnType<typeof targets>[number],
      ReturnType<typeof targets>[number],
    ];
    const first = await store.putPart({ ...one, body: bytes('a') });
    const second = await store.putPart({ ...two, body: bytes('b') });
    await store.completeMultipart({
      zone: 'quarantine',
      objectKey: KEY,
      providerUploadId: upload.providerUploadId,
      parts: [
        { partNumber: 1, etag: first?.etag ?? '' },
        { partNumber: 2, etag: second?.etag ?? '' },
      ],
    });
    return Buffer.concat([bytes('a'), bytes('b')]);
  }

  /** What the scan pass does: feed the one quarantine stream into the promotion's sink. */
  async function feed(sink: NodeJS.WritableStream, stream: NodeJS.ReadableStream): Promise<void> {
    for await (const chunk of stream) {
      if (!sink.write(chunk)) await new Promise<void>((done) => sink.once('drain', () => done()));
    }
  }

  async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  it('seals the bytes it was fed as the private object under the same key, and only on commit', async () => {
    const expected = await seal();
    const opened = await store.openObject({ zone: 'quarantine', objectKey: KEY });
    const promotion = await store.promote({ objectKey: KEY, sizeBytes: 2 * PART_SIZE });
    await feed(promotion.sink, opened.stream);
    // Nothing is sealed while the promotion is open: the private path is still empty.
    await expect(store.openObject({ zone: 'private', objectKey: KEY })).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
    const stored = await promotion.commit();
    expect(stored).toEqual({ sizeBytes: 2 * PART_SIZE, etag: md5(expected) });
    const promoted = await store.openObject({ zone: 'private', objectKey: KEY });
    expect(await drain(promoted.stream)).toEqual(expected);
    // The quarantine object is untouched: it is the evidence and the counted bytes.
    expect(
      await drain((await store.openObject({ zone: 'quarantine', objectKey: KEY })).stream),
    ).toEqual(expected);
    // No staging file is left beside the object.
    expect(walk(join(root, 'objects', 'private')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses to seal staged bytes that are not the size the row recorded, and leaves nothing behind', async () => {
    await seal();
    const opened = await store.openObject({ zone: 'quarantine', objectKey: KEY });
    const promotion = await store.promote({ objectKey: KEY, sizeBytes: 2 * PART_SIZE + 1 });
    await feed(promotion.sink, opened.stream);
    await expect(promotion.commit()).rejects.toBeInstanceOf(SizeMismatchError);
    await expect(store.openObject({ zone: 'private', objectKey: KEY })).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
    expect(
      existsSync(join(root, 'objects', 'private')) ? walk(join(root, 'objects', 'private')) : [],
    ).toEqual([]);
  });

  it('abort discards the staging file and touches nothing sealed', async () => {
    const expected = await seal();
    const opened = await store.openObject({ zone: 'quarantine', objectKey: KEY });
    const promotion = await store.promote({ objectKey: KEY, sizeBytes: 2 * PART_SIZE });
    await feed(promotion.sink, opened.stream);
    await promotion.abort();
    expect(
      existsSync(join(root, 'objects', 'private')) ? walk(join(root, 'objects', 'private')) : [],
    ).toEqual([]);
    await expect(store.openObject({ zone: 'private', objectKey: KEY })).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
    expect(
      await drain((await store.openObject({ zone: 'quarantine', objectKey: KEY })).stream),
    ).toEqual(expected);
    // The handle is one-shot: a commit after the abort is a bug, not a second object.
    await expect(promotion.commit()).rejects.toBeInstanceOf(PromotionClosedError);
  });

  it('a second promotion of the same key lands whole over the first — a pass re-run after a crash', async () => {
    const expected = await seal();
    for (let run = 0; run < 2; run += 1) {
      const opened = await store.openObject({ zone: 'quarantine', objectKey: KEY });
      const promotion = await store.promote({ objectKey: KEY, sizeBytes: 2 * PART_SIZE });
      await feed(promotion.sink, opened.stream);
      await promotion.commit();
    }
    const promoted = await store.openObject({ zone: 'private', objectKey: KEY });
    expect(await drain(promoted.stream)).toEqual(expected);
  });

  it('withdraw removes the private object and nothing else, and is idempotent', async () => {
    const expected = await seal();
    const opened = await store.openObject({ zone: 'quarantine', objectKey: KEY });
    const promotion = await store.promote({ objectKey: KEY, sizeBytes: 2 * PART_SIZE });
    await feed(promotion.sink, opened.stream);
    await promotion.commit();
    await store.withdraw({ objectKey: KEY });
    await expect(store.openObject({ zone: 'private', objectKey: KEY })).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
    expect(
      await drain((await store.openObject({ zone: 'quarantine', objectKey: KEY })).stream),
    ).toEqual(expected);
    await expect(store.withdraw({ objectKey: KEY })).resolves.toBeUndefined();
    await expect(store.withdraw({ objectKey: OTHER_KEY })).resolves.toBeUndefined();
  });

  it('withdraw refuses a directory at the private path rather than removing it', async () => {
    mkdirSync(store.objectPath('private', OTHER_KEY), { recursive: true });
    await expect(store.withdraw({ objectKey: OTHER_KEY })).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
    expect(existsSync(store.objectPath('private', OTHER_KEY))).toBe(true);
  });

  it('withdraw refuses a symbolic link at the private path, so a deletion never leaves the store', async (ctx) => {
    // The same fixture as openObject's symbolic-link case, one operation later, and not the
    // same danger. A read that followed the link would have disclosed the bytes it names;
    // `rm` does not follow one — it unlinks the link and leaves the target whole — so what an
    // absent guard would cost here is not the secret's bytes but the truth of the answer:
    // `withdraw` would consume a path this driver never wrote and return, telling its caller
    // the private object was destroyed when nothing of the store's was. Erasure is the one
    // thing `withdraw` is trusted for, and a withdrawal it did not make is the failure.
    requireSymlinkFixture(ctx, 'withdraw (FILE-002 slice B)');
    const secret = join(root, 'secret.txt');
    writeFileSync(secret, 'not an object');
    const path = store.objectPath('private', OTHER_KEY);
    mkdirSync(dirname(path), { recursive: true });
    // Any error from here is a fixture defect: it fails the case. Nothing is swallowed.
    symlinkSync(secret, path, 'file');
    // Reversal: `stat` instead of `lstat` and this resolves undefined, having unlinked the
    // link — a withdrawal reported for an object the store never held.
    await expect(store.withdraw({ objectKey: OTHER_KEY })).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
    // Refused, not tidied away: the link is left exactly where it was, as the directory case
    // above leaves its directory, and the file it names is untouched down to its bytes.
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(secret, 'utf8')).toBe('not an object');
  });

  it('checks the key before it touches the disk', async () => {
    await expect(
      store.promote({ objectKey: '../../etc/passwd', sizeBytes: 1 }),
    ).rejects.toBeInstanceOf(UnsafeObjectPathError);
    await expect(store.withdraw({ objectKey: '../../etc/passwd' })).rejects.toBeInstanceOf(
      UnsafeObjectPathError,
    );
  });
});
