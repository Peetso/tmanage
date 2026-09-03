/**
 * `@tmanage/storage` — the object-store port, its key layout, and the fake driver.
 *
 * A package rather than a folder in `apps/api` for `@tmanage/mail`'s reason: the API
 * reserves quota and begins uploads, and FILE-002's worker will verify and promote the
 * same objects — two apps, one port, and `18-REPOSITORY-STRUCTURE` forbids one app importing
 * another's `src/`. Like `mail`, this package is not in `18`'s tree; the divergence is
 * recorded in `docs/implementation-status.md`.
 *
 * **What is not here:** any real driver. FILE-001 is the reservation and the session; the
 * bytes are a later ticket (ADR-0002 assigns real R2 signature semantics to FILE-003), and
 * the configuration that names `s3` or `filesystem` refuses to wire until one exists.
 */

export type {
  AbortMultipartInput,
  BeginMultipartInput,
  CompleteMultipartInput,
  CompletedPart,
  MultipartUpload,
  ObjectStore,
  StoredObject,
  TrustZone,
  UploadTarget,
} from './object-store.js';
export { InvalidObjectKeyComponentError, uploadObjectKey } from './object-key.js';
export type { UploadObjectKeyInput } from './object-key.js';
export { FakeObjectStore } from './fake-object-store.js';
