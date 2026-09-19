/**
 * The object-store port — the interface the file stack moves bytes through.
 *
 * Modelled on `@tmanage/mail`'s `Mailer`: a small interface whose concrete driver is chosen
 * by configuration, so the service that reserves quota and records a file never learns
 * whether the bytes crossed a network. `packages/config` already names the two production
 * drivers — `STORAGE_DRIVER` is `s3` or `filesystem` — and this file is the type both will
 * implement. Today only the fake exists (FILE-001); the filesystem driver and the R2
 * signature semantics are later tickets, as ADR-0002 already records.
 *
 * ## Six methods, and what is deliberately absent
 *
 * `beginMultipart`, `completeMultipart`, `abortMultipart` — and, since FILE-002,
 * `openObject`: the bytes of a sealed object, streamed once, for **authorized processing**
 * only (`23-ERD` §10: "inaccessible outside upload owner/authorized processing until
 * `ready`"). It exists because verification has a rule — `03-TECHNICAL-ARCHITECTURE`
 * §108, "worker verifies checksum, MIME, size" — and a rule is what an earlier revision of
 * this header said a read would need before it was added. It is *not* a download: a
 * download URL is FILE-003's short-lived authorized link with its own rules
 * (`25-AUTH-AND-TENANT-ISOLATION` §9 caps it at five minutes), it is served to a principal,
 * and it is gated on `ready`. `openObject` is served to a job, under a service context,
 * on an object in `quarantine`, and answers a stream rather than a URL, so nothing it
 * returns can be handed to a browser. FILE-002 slice B added the last two: `promote`, the
 * one write into the `private` zone, and `withdraw`, its undo. Still absent: a general
 * delete, head, list and copy — deletion is FILE-003's retention hook, with its own rule
 * first.
 *
 * ## Promotion is the same pass, never a copy
 *
 * `49` §4 promotes an object from quarantine to private once "validation/scan passed". The
 * obvious shape — scan the quarantine object, then copy it — reads the bytes twice, and
 * what was scanned is then not provably what was served: on a bucket, a copy is a second
 * request against a key, and the header below this one already names hash-then-promote
 * as a time-of-check/time-of-use race. So `promote` does not copy. It opens a **staging
 * sink** in the private zone under the *same key*, and the scan pass writes every chunk
 * of the one stream it reads into the digest, the scanner and that sink together;
 * `commit` seals the staged bytes as the private object only when the pass has decided
 * `clean` and the digest matched the verified `content_hash`, and `abort` discards the
 * staging. The private object is therefore, by construction, the bytes the scanner saw.
 * The key is stable across zones (decision F1, ADR-0006): `object_key` is immutable at the
 * engine (0015/0018) and a row's `trust_zone` says which zone holds the servable object —
 * a divergence from `49` §4's per-zone layouts, recorded there.
 *
 * `withdraw` removes the private-zone object under a key. It exists for one reason: a
 * promotion is committed *before* the transaction that records the verdict, so a crash or
 * a lost race between the two leaves a private object that no row vouches for, and a
 * rejected asset must never keep one. The scan pass calls it after every conclusion that
 * is not `ready`, and never on an asset whose row already says `private`. It is not a
 * general delete: it names the private zone alone, and the quarantine object — the
 * evidence, the counted bytes — is FILE-003's to remove.
 *
 * The object then exists twice for a promoted version, under one key in two zones, until
 * FILE-003 deletes the quarantine copy of a `ready` version: `49` §5's reconciliation must
 * expect that. Recorded in `docs/implementation-status.md`.
 *
 * ## A sealed object is read, never re-read
 *
 * The verification pass hashes and sniffs in **one** pass over one stream, and what it
 * records is what it read. For that to be the object the client will later be served, the
 * object must be unalterable from the moment `completeMultipart` returns: the filesystem
 * driver removes the upload's manifest at completion, so every outstanding part URL
 * answers "not found" from then on. **The `s3` driver (FILE-003) must presign
 * `UploadPart` for the multipart upload, never `PutObject` on the key** — a `PutObject`
 * URL outlives the seal, and hash-then-promote becomes a time-of-check/time-of-use race
 * against a client that kept one. Written here, in the port, before the adapter exists.
 *
 * ## The adapter never composes a key
 *
 * `49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY` §4 fixes the key layout
 * (`tenant/{org}/project/{project}/upload/{upload}/…`) and the trust zones. The key is built
 * by `object-key.ts` and handed in; the driver stores under it. A driver that knew what a
 * tenant was would be a second place the tenant boundary is spelled, free to drift from
 * the first.
 */

/**
 * `49` §4's three trust zones. An upload lands in `quarantine` and is promoted to `private`
 * only by FILE-002's verification and scan; `derived` holds previews (FILE-004).
 */
export type TrustZone = 'quarantine' | 'private' | 'derived';

export interface UploadTarget {
  readonly partNumber: number;
  /** Where the caller PUTs this part. Opaque to everything but the browser. */
  readonly url: string;
}

export interface BeginMultipartInput {
  readonly zone: TrustZone;
  readonly objectKey: string;
  readonly partCount: number;
  /**
   * The size the caller declared and reserved against the quota (`49` §6 step 4). The
   * driver holds the upload to it: a part may carry no more than the declaration leaves
   * for it, and a completion whose bytes do not add up to it is refused before any object
   * exists — the security review of 2026-09-04 found both doors open without this.
   */
  readonly declaredBytes: number;
  readonly expiresInSeconds: number;
}

export interface MultipartUpload {
  /** The provider's own handle for the in-flight upload, needed to complete or abort it. */
  readonly providerUploadId: string;
  readonly parts: readonly UploadTarget[];
}

export interface CompletedPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface CompleteMultipartInput {
  readonly zone: TrustZone;
  readonly objectKey: string;
  readonly providerUploadId: string;
  readonly parts: readonly CompletedPart[];
}

export interface AbortMultipartInput {
  readonly zone: TrustZone;
  readonly objectKey: string;
  readonly providerUploadId: string;
}

/**
 * What the provider reports once an object exists. `sizeBytes` is the provider's count,
 * never the caller's declaration — `49` §6 step 6: "Completion verifies actual provider
 * size/checksum; the reservation is converted to used bytes."
 */
export interface StoredObject {
  readonly sizeBytes: number;
  readonly etag: string;
}

export interface OpenObjectInput {
  readonly zone: TrustZone;
  readonly objectKey: string;
}

/**
 * A sealed object, opened for one read. `sizeBytes` is what the store holds *now*, so a
 * caller can refuse an object whose size no longer matches the row that names it; the
 * stream yields the bytes exactly once. The caller consumes or destroys it — a stream
 * left open is a file handle left open.
 */
export interface OpenedObject {
  readonly sizeBytes: number;
  readonly stream: NodeJS.ReadableStream;
}

export interface PromoteObjectInput {
  /** The verified version's key; the private object lands under the same key. */
  readonly objectKey: string;
  /** The row's `size_bytes`. `commit` refuses staged bytes that do not add up to it. */
  readonly sizeBytes: number;
}

/**
 * An open promotion: a sink in the private zone that the scan pass feeds from the one
 * stream it reads. Exactly one of `commit` and `abort` is called; a `commit` whose byte
 * count is not the declared size throws `SizeMismatchError` and leaves nothing behind.
 * `abort` after `commit` is a no-op on the sealed object — use `withdraw` for that.
 */
export interface Promotion {
  readonly sink: NodeJS.WritableStream;
  commit(): Promise<StoredObject>;
  abort(): Promise<void>;
}

export interface WithdrawObjectInput {
  readonly objectKey: string;
}

/**
 * FILE-003's retention delete. Unlike {@link WithdrawObjectInput}, which names the private
 * zone alone, this names the zone explicitly: the retention job removes a rejected object's
 * bytes from `quarantine`, the zone they never left because the asset was never promoted.
 */
export interface RemoveObjectInput {
  readonly zone: TrustZone;
  readonly objectKey: string;
}

export interface ObjectStore {
  beginMultipart(input: BeginMultipartInput): Promise<MultipartUpload>;
  completeMultipart(input: CompleteMultipartInput): Promise<StoredObject>;
  /** Idempotent: aborting an upload the provider no longer knows is not an error. */
  abortMultipart(input: AbortMultipartInput): Promise<void>;
  /**
   * The bytes of a sealed object, for authorized processing (FILE-002). Throws
   * `ObjectNotFoundError` when nothing is stored under the zone and key — an upload that
   * was never completed, or an object something removed — so a verification pass records
   * an error rather than hashing nothing.
   */
  openObject(input: OpenObjectInput): Promise<OpenedObject>;
  /**
   * Open a staged write into the `private` zone under the key (FILE-002 slice B). The
   * bytes the caller writes are the bytes it is scanning; `commit` seals them as the
   * private object, `abort` discards them. Never a copy — see the header.
   */
  promote(input: PromoteObjectInput): Promise<Promotion>;
  /**
   * Remove the private-zone object under the key, if any. Idempotent: nothing there is
   * not an error. The one undo of a committed promotion; see the header for who may call
   * it and when.
   */
  withdraw(input: WithdrawObjectInput): Promise<void>;
  /**
   * Remove the object under the zone and key, if any (FILE-003's retention delete).
   * Idempotent: a re-run over an already-deleted object is not an error, which is what
   * lets the retention job be safe to run twice (`49-PRICING` §6 step 8 — delete is
   * confirmed before the counter is reduced, so a crash between the two re-deletes here
   * and finds nothing). It names the zone, so the job removes a rejected object's counted
   * bytes from `quarantine` without reaching the `private` zone `withdraw` owns.
   */
  remove(input: RemoveObjectInput): Promise<void>;
}
