import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
import type {
  AbortMultipartInput,
  BeginMultipartInput,
  CompleteMultipartInput,
  DerivativeKeyInput,
  MultipartUpload,
  ObjectStore,
  OpenObjectInput,
  OpenedObject,
  PromoteObjectInput,
  Promotion,
  PutDerivativeInput,
  RemoveObjectInput,
  StoredObject,
  TrustZone,
  WithdrawObjectInput,
} from './object-store.js';
import {
  assertRealPathUnder,
  assertSafeObjectKey,
  resolveUnder,
  tenantOfObjectKey,
} from './local-path.js';
import {
  derivePartSigningKey,
  mintPartToken,
  partTokenOrganization,
  verifyPartToken,
} from './part-token.js';

/**
 * The local substitute for a bucket — ADR-0002's `filesystem` driver (FILE-001b), and the
 * `local` driver production runs on.
 *
 * It runs for two `STORAGE_DRIVER` values. `filesystem` is development and the e2e stack,
 * and `packages/config` refuses it in production. `local` is production on single-host
 * shared hosting (Hostinger): the root is `STORAGE_LOCAL_ROOT`, absolute and outside the web
 * root, validated at boot by `prepareLocalStorageRoot` (`local-root.ts`) — a process whose
 * root fails that check does not start. `s3` stays the default and is untouched by either.
 * The signed part URLs this driver mints are HMAC (`part-token.ts`), short-lived
 * (`STORAGE_UPLOAD_URL_TTL_SECONDS`) and tenant-bound: the token names the organization, and
 * `putPart` refuses one whose organization is not the tenant prefix of the upload's key.
 *
 * ## On disk
 *
 *     <root>/objects/<zone>/<object key>              the completed objects, by trust zone
 *     <root>/objects/derived/tenant/<org>/derivative/… previews made by TManage (R4)
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
 * and part, the manifest must exist and not have expired, the token's organization must be
 * the tenant the manifest's key belongs to, the part must be within range and within the
 * part size. Everything else — whose upload this is, which project, which quota —
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
 * ## A read is of a regular file, under the zone, and nothing else
 *
 * `openObject` (FILE-002) resolves the path the way every write does, then refuses
 * anything that is not a regular file *before* following it: a symbolic link left under
 * the root by anything at all would otherwise let a verification pass hash — and later
 * serve — a file outside the store. `lstat`, not `stat`, is the check that sees the link.
 * The size answered is the file's size at open, so the caller can refuse an object whose
 * size no longer matches the row that names it.
 *
 * ## Promotion is a staged write beside the private path
 *
 * `promote` (FILE-002 slice B) opens `<root>/objects/private/<key>.<random>.tmp` and hands
 * back a sink; the scan pass writes the chunks of the quarantine stream it is hashing and
 * scanning into it. `commit` closes the file, holds its byte count to the size the row
 * recorded, and renames it over the private path — the same write-beside-then-rename every
 * other write here makes, so a reader never sees a half-promoted object and a second
 * promotion of the same key (a pass re-run after a crash) lands whole over the first.
 * `abort` closes and removes the staging file and touches nothing sealed. `withdraw`
 * removes the private object under a key, and only that: the quarantine object is never
 * touched by this driver after it is sealed. The port's header says who may call it.
 *
 * ## Derivatives are written whole, under a tenant key, in `derived` alone
 *
 * `putDerivative` (R4 slice 2) is the `derived` zone's one write: the generator's bytes, written
 * beside the path and renamed over it like every other write here, so a preview being served
 * while it is regenerated is the old bytes or the new ones. It refuses a key that is not under
 * `tenant/{uuid}/`, as `beginMultipart` does, and its zone is fixed — no caller can name
 * `private` and overwrite an original through it. `openDerivative` and `deleteDerivative` are
 * `openObject` and `remove` pinned to the same zone, with the same regular-file guard.
 *
 * ## Paths never escape the root
 *
 * `object-key.ts` builds keys from checked UUIDs, and this driver checks again through
 * `local-path.ts`: each key segment is restricted to a safe alphabet, `.`, `..`, NUL,
 * backslashes and absolute forms are refused, and the resolved path is asserted to lie under
 * the zone's directory. Before a read, a promotion, a completion or a delete touches a path,
 * its real path is asserted to lie under the root too, so a symlinked directory planted
 * under the root cannot carry the operation outside it. `beginMultipart` only opens uploads
 * for keys under `tenant/{uuid}/`. A driver that trusted its caller's key would be a second
 * place the tenant prefix could be escaped from. `abort` reads the manifest before
 * it deletes anything, and refuses a zone or key that is not the one the upload was opened
 * under: the one path whose failure mode is silent deletion does not act on a handle alone.
 */

const HANDLE = /^[0-9a-f]{32}$/;
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
    // Only a tenant's key opens an upload: the part tokens are bound to its organization.
    const organizationId = tenantOfObjectKey(input.objectKey);
    if (!organizationId) throw new UnsafeObjectPathError('objectKey');
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
      const token = mintPartToken(this.key, {
        organizationId,
        providerUploadId,
        partNumber,
        expiresAtMs,
      });
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
    // Tenant-bound: a token signed for another organization's upload is one more refusal.
    if (partTokenOrganization(input.token) !== tenantOfObjectKey(manifest.objectKey)) return null;
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
    await this.assertContained(destination);
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

  async promote(input: PromoteObjectInput): Promise<Promotion> {
    const destination = this.objectPath('private', input.objectKey);
    await this.assertContained(destination);
    await mkdir(dirname(destination), { recursive: true });
    const staging = temporaryBeside(destination);
    const file = createWriteStream(staging);
    const hash = createHash('md5');
    let written = 0;
    let closed = false;
    const counting = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        written += chunk.length;
        callback(null, chunk);
      },
    });
    counting.pipe(file);
    // A failure of the file stream surfaces on the sink the caller holds, not as an
    // unhandled event on a stream it never sees.
    file.on('error', (error) => {
      if (!closed) counting.destroy(error);
    });

    return {
      sink: counting,
      commit: async () => {
        if (closed) throw new PromotionClosedError();
        closed = true;
        counting.end();
        await once(file, 'close');
        if (written !== input.sizeBytes) {
          await rm(staging, { force: true, maxRetries: 3 });
          throw new SizeMismatchError(input.sizeBytes, written);
        }
        await rename(staging, destination);
        return { sizeBytes: written, etag: hash.digest('hex') };
      },
      abort: async () => {
        if (closed) return;
        closed = true;
        counting.unpipe(file);
        counting.destroy();
        // A write still in flight makes the file stream emit an error as it is destroyed
        // (`ERR_STREAM_DESTROYED`); it is the abort's own doing and not the caller's
        // problem. Waited on by hand: `events.once` would reject on that error.
        file.on('error', () => undefined);
        if (!file.closed) {
          file.destroy();
          await new Promise<void>((resolve) => file.once('close', () => resolve()));
        }
        await rm(staging, { force: true, maxRetries: 3 });
      },
    };
  }

  async withdraw(input: WithdrawObjectInput): Promise<void> {
    const path = this.objectPath('private', input.objectKey);
    await this.assertContained(path);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    // Only an object this driver could have written: never a directory, never a link.
    if (!info.isFile()) throw new ObjectNotFoundError();
    await rm(path, { force: true, maxRetries: 3 });
  }

  /**
   * FILE-003's retention delete. Resolves the path under the named zone the same checked way
   * every write does, refuses anything that is not a regular file (never a directory, never a
   * link — the `withdraw`/`openObject` guard, so a link left under the root cannot make this
   * remove a file outside the store), and is idempotent: nothing there returns without error.
   */
  async remove(input: RemoveObjectInput): Promise<void> {
    const path = this.objectPath(input.zone, input.objectKey);
    await this.assertContained(path);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    if (!info.isFile()) throw new ObjectNotFoundError();
    await rm(path, { force: true, maxRetries: 3 });
  }

  async putDerivative(input: PutDerivativeInput): Promise<StoredObject> {
    // Checked before anything is written, so a bad key never leaves a directory behind.
    const path = this.objectPath('derived', input.objectKey);
    if (!tenantOfObjectKey(input.objectKey)) throw new UnsafeObjectPathError('objectKey');
    await this.assertContained(path);
    // Never over a link or a directory something left at the path: `rename` would replace a
    // link with a file, which is harmless, but a directory there is not an object we wrote.
    try {
      const info = await lstat(path);
      if (!info.isFile()) throw new UnsafeObjectPathError('objectKey');
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    await mkdir(dirname(path), { recursive: true });
    await this.assertContained(path);
    const body = Buffer.from(input.body.buffer, input.body.byteOffset, input.body.byteLength);
    await this.writeAtomically(path, body);
    return { sizeBytes: body.length, etag: createHash('md5').update(body).digest('hex') };
  }

  async openDerivative(input: DerivativeKeyInput): Promise<OpenedObject> {
    return this.openObject({ zone: 'derived', objectKey: input.objectKey });
  }

  async deleteDerivative(input: DerivativeKeyInput): Promise<void> {
    return this.remove({ zone: 'derived', objectKey: input.objectKey });
  }

  async openObject(input: OpenObjectInput): Promise<OpenedObject> {
    const path = this.objectPath(input.zone, input.objectKey);
    await this.assertContained(path);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError();
      throw error;
    }
    // A link, a directory, a device: not an object this store wrote, whatever it points at.
    if (!info.isFile()) throw new ObjectNotFoundError();
    const range = input.range;
    return {
      sizeBytes: info.size,
      stream: range
        ? createReadStream(path, { start: range.start, end: range.end })
        : createReadStream(path),
    };
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
    return resolveUnder(resolve(this.root, 'objects', zone), assertSafeObjectKey(objectKey));
  }

  /**
   * The real path of `path` (its deepest existing ancestor) must lie under the root: a
   * symlinked directory under the root cannot redirect a read, a write or a delete. A root
   * that does not exist yet holds no link to follow, so its absence is not a refusal.
   */
  private async assertContained(path: string): Promise<void> {
    try {
      await assertRealPathUnder(this.root, path);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
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
