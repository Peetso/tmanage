/**
 * `@tmanage/storage` — the object-store port, its key layout, and the fake driver.
 *
 * A package rather than a folder in `apps/api` for `@tmanage/mail`'s reason: the API
 * reserves quota and begins uploads, and FILE-002's worker will verify and promote the
 * same objects — two apps, one port, and `18-REPOSITORY-STRUCTURE` forbids one app importing
 * another's `src/`. Like `mail`, this package is not in `18`'s tree; the divergence is
 * recorded in `docs/implementation-status.md`.
 *
 * **Two drivers.** `FakeObjectStore` for suites, `FilesystemObjectStore` for a deployment
 * without a bucket — ADR-0002's local substitute, with HMAC-signed part URLs the API serves
 * itself (FILE-001b). The `s3` driver with real R2 signature semantics is FILE-003's, and the
 * configuration that names it still refuses to wire until it exists. FILE-002 gave the port
 * its first read, `openObject`, for the verification pass and nothing else — see the port's
 * header for the rule that admitted it.
 */

export type {
  AbortMultipartInput,
  BeginMultipartInput,
  CompleteMultipartInput,
  CompletedPart,
  MultipartUpload,
  ObjectStore,
  OpenObjectInput,
  OpenedObject,
  StoredObject,
  TrustZone,
  UploadTarget,
} from './object-store.js';
export { InvalidObjectKeyComponentError, uploadObjectKey } from './object-key.js';
export type { UploadObjectKeyInput } from './object-key.js';
export { FakeObjectStore } from './fake-object-store.js';
export { FilesystemObjectStore } from './filesystem-object-store.js';
export type {
  FilesystemObjectStoreOptions,
  PartSink,
  PutPartInput,
  PutPartResult,
} from './filesystem-object-store.js';
export {
  createPartAdmission,
  derivePartSigningKey,
  mintPartToken,
  verifyPartToken,
} from './part-token.js';
export type { PartAdmission, PartTokenClaims } from './part-token.js';
export {
  MissingPartError,
  MultipartUploadMismatchError,
  MultipartUploadNotFoundError,
  ObjectNotFoundError,
  PartEtagMismatchError,
  PartTooLargeError,
  SizeMismatchError,
  UnsafeObjectPathError,
} from './errors.js';
