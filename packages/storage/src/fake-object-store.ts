import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
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
  WithdrawObjectInput,
} from './object-store.js';
import { ObjectNotFoundError, PromotionClosedError, SizeMismatchError } from './errors.js';

/**
 * The driver a suite holds in its hand — `packages/mail`'s console driver, for bytes.
 *
 * No bytes move. `beginMultipart` answers `memory://` URLs, a scheme nothing can fetch, so
 * a test that accidentally treats one as reachable fails loudly instead of touching a
 * network. `completeMultipart` answers whatever size the suite configured for the key, and
 * the declared size otherwise — which is how a size mismatch (`27-TEST-CATALOG` INT-12,
 * "declared size differs from actual") is provable with no object anywhere.
 *
 * Everything the store was asked is recorded, because "was the provider asked to abort"
 * is a fact a release path has to be able to assert.
 *
 * `openObject` answers the bytes a suite placed under the key in {@link objects}, and
 * `ObjectNotFoundError` for a key it holds nothing under — so a verification case can be
 * run against this fake with the bytes it chooses, and the "object gone" case with none.
 *
 * `promote` collects what the caller writes and, on `commit`, places it under
 * `private/objectKey` in {@link objects} — so a suite can assert that the private object
 * is the bytes the scan saw. `withdraw` removes that entry; both are recorded.
 */
export class FakeObjectStore implements ObjectStore {
  readonly began: BeginMultipartInput[] = [];
  readonly completed: CompleteMultipartInput[] = [];
  readonly aborted: AbortMultipartInput[] = [];
  /** Provider-reported sizes, by object key. Absent means "the size the caller declared". */
  readonly sizeFor = new Map<string, number>();
  /** The bytes `openObject` answers, by `zone/objectKey`. A suite writes them; nothing else does. */
  readonly objects = new Map<string, Buffer>();
  /** Every `openObject` call, whether or not it found anything. */
  readonly opened: OpenObjectInput[] = [];
  /** Every promotion opened, and every one committed or aborted. */
  readonly promoted: PromoteObjectInput[] = [];
  readonly committed: string[] = [];
  readonly abortedPromotions: string[] = [];
  /** Every `withdraw` call, by key. */
  readonly withdrawn: string[] = [];
  /** Every `remove` call (FILE-003), in order — so a retention proof can assert the delete ran. */
  readonly removed: RemoveObjectInput[] = [];
  /** R4 slice 2: every derivative written and every one deleted, by key, in order. */
  readonly derivativesPut: string[] = [];
  readonly derivativesDeleted: string[] = [];
  /** Thrown by the next call to any method, then cleared. The provider being down. */
  failNext: Error | null = null;
  /**
   * Thrown by the next `abortMultipart` only, then cleared — the provider that opened an
   * upload and then refuses to abandon it, which is the failure the error path has to
   * survive without losing the error it was handling.
   */
  failNextAbort: Error | null = null;

  private counter = 0;
  /** What each upload declared at `beginMultipart`, by handle — the provider's own record. */
  private readonly declared = new Map<string, number>();

  constructor(private readonly defaultSizeFor: (objectKey: string) => number) {}

  async beginMultipart(input: BeginMultipartInput): Promise<MultipartUpload> {
    this.consumeFailure();
    this.began.push(input);
    this.counter += 1;
    const providerUploadId = `fake-upload-${this.counter}`;
    this.declared.set(providerUploadId, input.declaredBytes);
    const parts = Array.from({ length: input.partCount }, (_, index) => ({
      partNumber: index + 1,
      url: `memory://${providerUploadId}/part/${index + 1}`,
    }));
    return { providerUploadId, parts };
  }

  async completeMultipart(input: CompleteMultipartInput): Promise<StoredObject> {
    this.consumeFailure();
    this.completed.push(input);
    const sizeBytes = this.sizeFor.get(input.objectKey) ?? this.defaultSizeFor(input.objectKey);
    // The provider refuses, as the filesystem driver does, before any object exists. An
    // upload this fake never began (a port test completing a bare handle) has no
    // declaration to hold it to.
    const declared = this.declared.get(input.providerUploadId);
    if (declared !== undefined && sizeBytes !== declared) {
      throw new SizeMismatchError(declared, sizeBytes);
    }
    return { sizeBytes, etag: `fake-etag-${input.parts.length}` };
  }

  async openObject(input: OpenObjectInput): Promise<OpenedObject> {
    this.consumeFailure();
    this.opened.push(input);
    const bytes = this.objects.get(`${input.zone}/${input.objectKey}`);
    if (!bytes) throw new ObjectNotFoundError();
    return { sizeBytes: bytes.length, stream: Readable.from([bytes]) };
  }

  async promote(input: PromoteObjectInput): Promise<Promotion> {
    this.consumeFailure();
    this.promoted.push(input);
    const chunks: Buffer[] = [];
    let closed = false;
    const sink = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        if (closed) {
          callback(new PromotionClosedError());
          return;
        }
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    return {
      sink,
      commit: async () => {
        if (closed) throw new PromotionClosedError();
        closed = true;
        const bytes = Buffer.concat(chunks);
        if (bytes.length !== input.sizeBytes) {
          throw new SizeMismatchError(input.sizeBytes, bytes.length);
        }
        this.objects.set(`private/${input.objectKey}`, bytes);
        this.committed.push(input.objectKey);
        return { sizeBytes: bytes.length, etag: `fake-etag-promoted` };
      },
      abort: async () => {
        if (closed) return;
        closed = true;
        this.abortedPromotions.push(input.objectKey);
      },
    };
  }

  async withdraw(input: WithdrawObjectInput): Promise<void> {
    this.consumeFailure();
    this.withdrawn.push(input.objectKey);
    this.objects.delete(`private/${input.objectKey}`);
  }

  async remove(input: RemoveObjectInput): Promise<void> {
    // `consumeFailure` first, before the record and the delete, so `failNext` models a
    // provider that refused the delete: nothing is recorded as removed and the object stays.
    this.consumeFailure();
    this.removed.push(input);
    this.objects.delete(`${input.zone}/${input.objectKey}`);
  }

  /** Stored under `derived/objectKey` in {@link objects}, so `openDerivative` reads it back. */
  async putDerivative(input: PutDerivativeInput): Promise<StoredObject> {
    this.consumeFailure();
    const bytes = Buffer.from(input.body);
    this.derivativesPut.push(input.objectKey);
    this.objects.set(`derived/${input.objectKey}`, bytes);
    return { sizeBytes: bytes.length, etag: createHash('md5').update(bytes).digest('hex') };
  }

  async openDerivative(input: DerivativeKeyInput): Promise<OpenedObject> {
    return this.openObject({ zone: 'derived', objectKey: input.objectKey });
  }

  async deleteDerivative(input: DerivativeKeyInput): Promise<void> {
    this.consumeFailure();
    this.derivativesDeleted.push(input.objectKey);
    this.objects.delete(`derived/${input.objectKey}`);
  }

  async abortMultipart(input: AbortMultipartInput): Promise<void> {
    this.consumeFailure();
    if (this.failNextAbort) {
      const error = this.failNextAbort;
      this.failNextAbort = null;
      throw error;
    }
    this.aborted.push(input);
  }

  private consumeFailure(): void {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
  }
}
