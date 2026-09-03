import { Global, Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type {
  AbortMultipartInput,
  BeginMultipartInput,
  CompleteMultipartInput,
  MultipartUpload,
  ObjectStore,
  StoredObject,
} from '@tmanage/storage';
import { OBJECT_STORE } from '../http/tokens.js';

/**
 * The object-store wiring — `MailerModule`'s dual shape, applied to bytes.
 *
 * `forObjectStore` is what a suite calls with the fake it holds; `none()` is what `AppModule`
 * falls back to when the composition root passes nothing. There is deliberately no
 * `forConfig` yet: `STORAGE_DRIVER` names `s3` and `filesystem`, and neither driver exists
 * in this slice (FILE-001 is the session and the reservation; the bytes are FILE-001b's
 * local transport and FILE-003's real R2 semantics, per ADR-0002). A `forConfig` that
 * answered a driver for either name would be claiming a capability the deployment does not
 * have, so `main.ts` passes nothing and the API says so at the first provider call rather
 * than at boot — every route that is not an upload keeps working.
 *
 * `@Global` for `MailerModule`'s reason: the producer is a feature module built through
 * `.register()`, and importing a dynamic module twice builds it twice.
 */

export class ObjectStoreUnavailableError extends Error {
  constructor() {
    super('No object store is configured in this deployment (FILE-001b / FILE-003)');
    this.name = 'ObjectStoreUnavailableError';
  }
}

/** Every call throws. The honest shape of "no driver exists yet". */
class UnavailableObjectStore implements ObjectStore {
  beginMultipart(_input: BeginMultipartInput): Promise<MultipartUpload> {
    return Promise.reject(new ObjectStoreUnavailableError());
  }
  completeMultipart(_input: CompleteMultipartInput): Promise<StoredObject> {
    return Promise.reject(new ObjectStoreUnavailableError());
  }
  abortMultipart(_input: AbortMultipartInput): Promise<void> {
    return Promise.reject(new ObjectStoreUnavailableError());
  }
}

function moduleFor(store: ObjectStore): DynamicModule {
  const provider: Provider = { provide: OBJECT_STORE, useValue: store };
  return { module: StorageModule, global: true, providers: [provider], exports: [provider] };
}

@Global()
@Module({})
export class StorageModule {
  /** A suite's store, held by the suite. */
  static forObjectStore(store: ObjectStore): DynamicModule {
    return moduleFor(store);
  }

  /** No driver at all: the first provider call throws `ObjectStoreUnavailableError`. */
  static none(): DynamicModule {
    return moduleFor(new UnavailableObjectStore());
  }
}
