/**
 * The typed failures a driver may answer, so the service that called it can decide what each
 * one means for the reservation. `object-key.ts`'s discipline throughout: the offending value
 * is never repeated in the message, because it is exactly the thing that failed to look like
 * what it should and may be anything.
 */

/** The provider no longer knows this upload: aborted, completed, expired, or never opened. */
export class MultipartUploadNotFoundError extends Error {
  constructor() {
    super('the multipart upload is not known to the store');
    this.name = 'MultipartUploadNotFoundError';
  }
}

/** The caller named a zone or key that is not the one the upload was opened under. A bug. */
export class MultipartUploadMismatchError extends Error {
  constructor() {
    super('the multipart upload was opened under a different zone or key');
    this.name = 'MultipartUploadMismatchError';
  }
}

/** Completion named a part that was never received. */
export class MissingPartError extends Error {
  constructor(readonly partNumber: number) {
    super(`part ${partNumber} was never uploaded`);
    this.name = 'MissingPartError';
  }
}

/** The etag the caller presented for a part is not the etag the store computed for it. */
export class PartEtagMismatchError extends Error {
  constructor(readonly partNumber: number) {
    super(`part ${partNumber} does not match the etag presented for it`);
    this.name = 'PartEtagMismatchError';
  }
}

/** A part body larger than the configured part size. The transport refuses it before writing. */
export class PartTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`a part may not exceed ${maxBytes} bytes`);
    this.name = 'PartTooLargeError';
  }
}

/**
 * The assembled bytes do not add up to the size the upload was opened with. Refused before
 * the object exists: a completion that first materialised the object and then reported
 * its size left a real, uncounted, undeletable file behind for every mismatch (security
 * review, 2026-09-04). The parts and the manifest stay, as for an etag mismatch.
 */
export class SizeMismatchError extends Error {
  constructor(
    readonly declaredBytes: number,
    readonly actualBytes: number,
  ) {
    super(`the upload holds ${actualBytes} bytes; ${declaredBytes} were declared`);
    this.name = 'SizeMismatchError';
  }
}

/** A key or handle component that would compose a path outside the store's root. */
export class UnsafeObjectPathError extends Error {
  constructor(readonly component: string) {
    super(`object path component ${component} is not safe`);
    this.name = 'UnsafeObjectPathError';
  }
}
