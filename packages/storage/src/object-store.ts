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
 * ## Four methods, and what is deliberately absent
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
 * returns can be handed to a browser. Still absent: delete, head, list, copy — deletion is
 * FILE-003's retention hook and promotion is slice B's, each with its own rule first.
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
}
