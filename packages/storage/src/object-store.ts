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
 * ## Three methods, and what is deliberately absent
 *
 * `beginMultipart`, `completeMultipart`, `abortMultipart`. No download, no delete, no
 * listing: a download URL is FILE-003's short-lived authorized link and carries its own
 * rules (`25-AUTH-AND-TENANT-ISOLATION` §9 caps it at five minutes); deletion is FILE-003's
 * retention hook. A port with a `getObject` nobody has a rule for yet would be an escape
 * hatch waiting for a caller.
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

export interface ObjectStore {
  beginMultipart(input: BeginMultipartInput): Promise<MultipartUpload>;
  completeMultipart(input: CompleteMultipartInput): Promise<StoredObject>;
  /** Idempotent: aborting an upload the provider no longer knows is not an error. */
  abortMultipart(input: AbortMultipartInput): Promise<void>;
}
