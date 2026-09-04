import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  MissingPartError,
  MultipartUploadMismatchError,
  MultipartUploadNotFoundError,
  PartEtagMismatchError,
  PartTooLargeError,
  SizeMismatchError,
  UnsafeObjectPathError,
} from './errors.js';
import type {
  AbortMultipartInput,
  BeginMultipartInput,
  CompleteMultipartInput,
  MultipartUpload,
  ObjectStore,
  StoredObject,
  TrustZone,
} from './object-store.js';
import { derivePartSigningKey, mintPartToken, verifyPartToken } from './part-token.js';

/**
 * The local substitute for a bucket — ADR-0002's `filesystem` driver (FILE-001b).
 *
 * It runs where `STORAGE_DRIVER=filesystem` is legal: development and the e2e stack.
 * `packages/config` refuses the driver in production, where `s3` is named and the part
 * route is bound to no sink.
 *
 * ## On disk
 *
 *     <root>/objects/<zone>/<object key>              the completed objects, by trust zone
 *     <root>/uploads/<providerUploadId>/manifest.json  one in-flight multipart upload
 *     <root>/uploads/<providerUploadId>/part-0001…     its parts, as they arrive
 *
 * ## The manifest is the revocation
 *
 * A signed part URL cannot be recalled inside its lifetime; the upload directory can. `abort`
 * removes it, and from that moment every outstanding URL for the upload answers "not
 * found" — which is the lock behind `FilesService` no longer serving targets once a session
 * leaves `reserved`. `complete` removes it too, so a late PUT cannot alter a sealed object.
 * The manifest also records the part size the upload was opened at, so an upload in flight
 * across a configuration change is judged by the size its URLs were minted for, not by the
 * process's current one.
 *
 * ## What the PUT verifies without a database
 *
 * The handle in the path must be a handle, the token must verify for exactly that handle
 * and part, the manifest must exist and not have expired, the part must be within range and
 * within the part size. Everything else — whose upload this is, which project, which quota —
 * was decided when the session was created, and is not re-decided by a byte sink. Every
 * refusal is one `null`; the route turns it into one 404.
 *
 * ## Completion is one pass
 *
 * Each part is hashed and counted **while** it is streamed into a staging file private to
 * the call, and its digest compared to the etag presented for it before the next part is
 * read. There is no second read between a verification and the assembly for a late PUT to
 * slip into: the bytes the size and etag describe are the bytes that were written. A
 * refusal — a part missing, an etag that does not match — discards the staging file and
 * leaves the upload open, so the client can PUT the part again and complete again (S3
 * leaves the upload intact on `InvalidPart` too; `FilesService` decision 11).
 *
 * ## Etags
 *
 * A part's etag is the hex MD5 of its bytes, S3's shape for a single part, and the object's
 * is S3's composite (`md5(concat(binary part digests))-partCount`), so a client written
 * against this driver needs no change when FILE-003 swaps in the real one. MD5 here is an
 * integrity check on bytes the same caller just sent, not a security primitive.
 *
 * ## Paths never escape the root
 *
 * `object-key.ts` builds keys from checked UUIDs, and this driver checks again: each key
 * segment is restricted to a safe alphabet, `.` and `..` are refused, and the resolved path is
 * asserted to lie under the zone's directory. A driver that trusted its caller's key would be
 * a second place the tenant prefix could be escaped from. `abort` reads the manifest before
 * it deletes anything, and refuses a zone or key that is not the one the upload was opened
 * under: the one path whose failure mode is silent deletion does not act on a handle alone.
 */

const HANDLE = /^[0-9a-f]{32}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ZONES: readonly TrustZone[] = ['quarantine', 'private', 'derived'];
/** Bumped when the manifest gains a field; an older manifest reads as "unknown upload". */
const MANIFEST_VERSION = 3;

export interface FilesystemObjectStoreOptions {
  /** Where everything lives. Resolved once; every path is checked to stay beneath it. */
  readonly root: string;
  /** `STORAGE_LOCAL_SIGNING_SECRET`. Never the session or CSRF secret. */
  readonly signingSecret: string;
  /** `API_PUBLIC_URL`, from configuration and never from a request header. */
  readonly publicUrl: string;
  /** The largest body one part may carry; `FilesService`'s part size. */
  readonly partSizeBytes: number;
  /** Injectable clock, for the expiry cases. */
  readonly now?: () => number;
}

/** What the transport route hands the store, and what it gets back. */
export interface PutPartInput {
  readonly providerUploadId: string;
  readonly partNumber: number;
  readonly token: string | undefined;
  readonly body: Buffer;
}

export interface PutPartResult {
  readonly etag: string;
}

/** The half of the driver the public PUT route talks to. */
export interface PartSink {
  /** `null` for every refusal — unknown, forged, expired, aborted, completed, out of range. */
  putPart(input: PutPartInput): Promise<PutPartResult | null>;
}

interface Manifest {
  readonly version: number;
  readonly providerUploadId: string;
  readonly zone: TrustZone;
  readonly objectKey: string;
  readonly partCount: number;
  /** The ceiling the upload's URLs were minted for; `putPart` refuses above it. */
  readonly partSizeBytes: number;
  /**
   * The size declared and reserved at `beginMultipart`. Two refusals stand on it: a part
   * may carry no more than the declaration leaves for its position, and a completion whose
   * bytes do not add up to it is refused before the object exists (security review,
   * 2026-09-04 — without it a one-byte reservation held a full part on disk, and a
   * mismatched completion left a real, uncounted, undeletable object).
   */
  readonly declaredBytes: number;
  readonly expiresAtMs: number;
}

/** What part `partNumber` of a `declaredBytes` upload may carry at most. Never below zero. */
function partCeiling(manifest: Manifest, partNumber: number): number {
  const remaining = manifest.declaredBytes - (partNumber - 1) * manifest.partSizeBytes;
  return Math.max(0, Math.min(manifest.partSizeBytes, remaining));
}

function partFileName(partNumber: number): string {
  return `part-${String(partNumber).padStart(4, '0')}`;
}

function normalizeEtag(etag: string): string {
  return etag.replace(/^"|"$/g, '').toLowerCase();
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

/** A per-call name beside the target, so two writers of one path never share a file. */
function temporaryBeside(path: string): string {
  return `${path}.${randomBytes(6).toString('hex')}.tmp`;
}

/** Close the staging stream if it is still open, then remove the file it was writing. */
async function discard(sink: WriteStream, staging: string): Promise<void> {
  if (!sink.closed) {
    sink.destroy();
    await once(sink, 'close');
  }
  await rm(staging, { force: true, maxRetries: 3 });
}

export class FilesystemObjectStore implements ObjectStore, PartSink {
  private readonly root: string;
  private readonly key: Buffer;
  private readonly publicUrl: string;
  private readonly partSizeBytes: number;
  private readonly now: () => number;

  constructor(options: FilesystemObjectStoreOptions) {
    this.root = resolve(options.root);
    this.key = derivePartSigningKey(options.signingSecret);
    this.publicUrl = options.publicUrl.replace(/\/+$/, '');
    this.partSizeBytes = options.partSizeBytes;
    this.now = options.now ?? (() => Date.now());
  }

  async beginMultipart(input: BeginMultipartInput): Promise<MultipartUpload> {
    // Checked before anything is written, so a bad key never leaves a directory behind.
    this.objectPath(input.zone, input.objectKey);
    const providerUploadId = randomBytes(16).toString('hex');
    const expiresAtMs = this.now() + input.expiresInSeconds * 1_000;
    const manifest: Manifest = {
      version: MANIFEST_VERSION,
      providerUploadId,
      zone: input.zone,
      objectKey: input.objectKey,
      partCount: input.partCount,
      partSizeBytes: this.partSizeBytes,
      declaredBytes: input.declaredBytes,
      expiresAtMs,
    };
    const directory = this.uploadDirectory(providerUploadId);
    await mkdir(directory, { recursive: true });
    await this.writeAtomically(`${directory}${sep}manifest.json`, JSON.stringify(manifest));

    const parts = Array.from({ length: input.partCount }, (_, index) => {
      const partNumber = index + 1;
      const token = mintPartToken(this.key, { providerUploadId, partNumber, expiresAtMs });
      return {
        partNumber,
        url: `${this.publicUrl}/v1/uploads/${providerUploadId}/parts/${partNumber}?t=${token}`,
      };
    });
    return { providerUploadId, parts };
  }

  async putPart(input: PutPartInput): Promise<PutPartResult | null> {
    if (!HANDLE.test(input.providerUploadId)) return null;
    if (!Number.isSafeInteger(input.partNumber) || input.partNumber < 1) return null;
    if (
      !verifyPartToken(this.key, input.token, input.providerUploadId, input.partNumber, this.now())
    ) {
      return null;
    }
    const manifest = await this.readManifest(input.providerUploadId);
    if (!manifest) return null;
    // Both checks below are also made by the token, which carries the same expiry and was
    // minted for a part the upload has. They stand for the manifest's own authority — a
    // token minted by hand for a part the upload lacks, or outliving the manifest, is
    // still refused — and the unit suite reaches each of them with such a token.
    if (manifest.expiresAtMs <= this.now()) return null;
    if (input.partNumber > manifest.partCount) return null;
    // Refused after the authorization checks, so a forged request that the transport let
    // through learns nothing about the limit; refused before the write, so nothing over
    // the limit ever touches disk. The ceiling is the upload's own, from its manifest:
    // the part size, and no more than the declaration leaves for this part — so a
    // one-byte reservation cannot hold a full part on disk.
    const ceiling = partCeiling(manifest, input.partNumber);
    if (input.body.length > ceiling) {
      throw new PartTooLargeError(ceiling);
    }

    const directory = this.uploadDirectory(input.providerUploadId);
    await this.writeAtomically(`${directory}${sep}${partFileName(input.partNumber)}`, input.body);
    return { etag: createHash('md5').update(input.body).digest('hex') };
  }

  async completeMultipart(input: CompleteMultipartInput): Promise<StoredObject> {
    const manifest = await this.readManifest(input.providerUploadId);
    if (!manifest) throw new MultipartUploadNotFoundError();
    if (manifest.zone !== input.zone || manifest.objectKey !== input.objectKey) {
      throw new MultipartUploadMismatchError();
    }
    // An upload past its expiry is one the store no longer holds, whatever is on disk.
    if (manifest.expiresAtMs <= this.now()) throw new MultipartUploadNotFoundError();
    const directory = this.uploadDirectory(input.providerUploadId);
    const presented = new Map(input.parts.map((p) => [p.partNumber, normalizeEtag(p.etag)]));

    const destination = this.objectPath(manifest.zone, manifest.objectKey);
    await mkdir(dirname(destination), { recursive: true });
    const staging = `${directory}${sep}object.${randomBytes(8).toString('hex')}.tmp`;
    const sink = createWriteStream(staging);

    // One pass: each part is hashed and counted as it is appended, and checked against the
    // etag presented for it before the next part is read.
    const digests: Buffer[] = [];
    let sizeBytes = 0;
    try {
      for (let partNumber = 1; partNumber <= manifest.partCount; partNumber += 1) {
        const path = `${directory}${sep}${partFileName(partNumber)}`;
        try {
          await stat(path);
        } catch (error) {
          if (isNotFound(error)) throw new MissingPartError(partNumber);
          throw error;
        }
        const hash = createHash('md5');
        let partBytes = 0;
        const counting = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            partBytes += chunk.length;
            callback(null, chunk);
          },
        });
        await pipeline(createReadStream(path), counting, sink, {
          end: partNumber === manifest.partCount,
        });
        const digest = hash.digest();
        if (presented.get(partNumber) !== digest.toString('hex')) {
          throw new PartEtagMismatchError(partNumber);
        }
        digests.push(digest);
        sizeBytes += partBytes;
      }
    } catch (error) {
      // The staging file goes; the parts and the manifest stay, so the upload can be
      // completed again once the client has re-sent what was wrong.
      await discard(sink, staging);
      throw error;
    }

    // Before the object exists, never after: a mismatch that first landed the object left
    // a real file the reservation no longer covered and nothing could delete. The parts
    // stay, as for an etag mismatch; the caller decides what the session becomes.
    if (sizeBytes !== manifest.declaredBytes) {
      await discard(sink, staging);
      throw new SizeMismatchError(manifest.declaredBytes, sizeBytes);
    }

    // The object exists before the staging directory disappears: a crash between the two
    // leaves an upload that `abort` can still clean, never an object nobody can find.
    await rename(staging, destination);
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });

    const composite = createHash('md5').update(Buffer.concat(digests)).digest('hex');
    return { sizeBytes, etag: `${composite}-${manifest.partCount}` };
  }

  /**
   * Idempotent: an upload the store no longer knows is not an error (`ObjectStore`). An
   * upload it does know is removed only under the zone and key it was opened with — a
   * caller naming another pair is a bug, and a bug does not delete.
   */
  async abortMultipart(input: AbortMultipartInput): Promise<void> {
    if (!HANDLE.test(input.providerUploadId)) return;
    const manifest = await this.readManifest(input.providerUploadId);
    if (!manifest) return;
    if (manifest.zone !== input.zone || manifest.objectKey !== input.objectKey) {
      throw new MultipartUploadMismatchError();
    }
    await rm(this.uploadDirectory(input.providerUploadId), {
      recursive: true,
      force: true,
      maxRetries: 3,
    });
  }

  /** Where a completed object lives — exposed for a suite that checks the bytes landed. */
  objectPath(zone: TrustZone, objectKey: string): string {
    if (!ZONES.includes(zone)) throw new UnsafeObjectPathError('zone');
    const segments = objectKey.split('/');
    for (const segment of segments) {
      if (!SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..') {
        throw new UnsafeObjectPathError('objectKey');
      }
    }
    const zoneRoot = resolve(this.root, 'objects', zone);
    const path = resolve(zoneRoot, ...segments);
    if (!path.startsWith(`${zoneRoot}${sep}`)) throw new UnsafeObjectPathError('objectKey');
    return path;
  }

  private uploadDirectory(providerUploadId: string): string {
    if (!HANDLE.test(providerUploadId)) throw new UnsafeObjectPathError('providerUploadId');
    return resolve(this.root, 'uploads', providerUploadId);
  }

  private async readManifest(providerUploadId: string): Promise<Manifest | null> {
    let raw: string;
    try {
      raw = await readFile(`${this.uploadDirectory(providerUploadId)}${sep}manifest.json`, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    const manifest = JSON.parse(raw) as Manifest;
    return manifest.version === MANIFEST_VERSION ? manifest : null;
  }

  /**
   * Write beside, then rename over: a reader never sees a half-written file. The temporary
   * name is per call, so two writers of the same part — a client retrying into its own
   * earlier attempt — each land whole, and the etag each is answered is the etag of what it
   * sent. A write that fails leaves nothing behind.
   */
  private async writeAtomically(path: string, content: string | Buffer): Promise<void> {
    const temporary = temporaryBeside(path);
    try {
      await writeFile(temporary, content);
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true, maxRetries: 3 });
      throw error;
    }
  }
}
