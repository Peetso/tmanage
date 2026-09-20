import { Global, Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { FilesystemObjectStore } from '@tmanage/storage';
import type {
  AbortMultipartInput,
  BeginMultipartInput,
  CompleteMultipartInput,
  MultipartUpload,
  ObjectStore,
  OpenObjectInput,
  OpenedObject,
  PartSink,
  PromoteObjectInput,
  Promotion,
  RemoveObjectInput,
  StoredObject,
  WithdrawObjectInput,
} from '@tmanage/storage';
import { LOCAL_PART_SINK, OBJECT_STORE } from '../http/tokens.js';

/**
 * The object-store wiring — `MailerModule`'s dual shape, applied to bytes.
 *
 * `forConfig` is what `main.ts` calls with the environment's answers; `forObjectStore` is
 * what a suite calls with the fake it holds; `none()` is what `AppModule` falls back to when
 * the composition root passes nothing.
 *
 * Of `STORAGE_DRIVER`'s two names, one exists: `filesystem` is ADR-0002's local substitute
 * (FILE-001b) — the driver keeps objects under `STORAGE_FILESYSTEM_ROOT` and serves its own
 * HMAC-signed part URLs, which the public PUT route accepts through the driver's `PartSink`
 * half. `s3` — R2's real signature semantics — is FILE-003's, and naming it still wires the
 * store that refuses at the first provider call rather than at boot, so every route that is
 * not an upload keeps working in a deployment whose bucket is a later ticket. Claiming a
 * driver that does not exist would be worse than refusing honestly.
 *
 * `LOCAL_PART_SINK` is provided by `forConfig` alone. A suite holding a fake, or a deployment
 * with no driver, leaves it unbound; the route injects it `@Optional()` and answers 404 to
 * everything — the same body a forged token gets, which is the honest shape of "no sink".
 *
 * `@Global` for `MailerModule`'s reason: the producer is a feature module built through
 * `.register()`, and importing a dynamic module twice builds it twice.
 */

export interface StorageModuleConfig {
  readonly driver: 's3' | 'filesystem';
  /** `STORAGE_FILESYSTEM_ROOT`. Relative paths resolve against the process's cwd. */
  readonly root: string;
  /** `STORAGE_LOCAL_SIGNING_SECRET`. `packages/config` requires it for `filesystem`. */
  readonly signingSecret?: string | undefined;
  /** `API_PUBLIC_URL` — from configuration, never from a request header. */
  readonly publicUrl: string;
  /** `UPLOAD_PART_SIZE_BYTES`, the same number `ApiConfig.uploadPartSizeBytes` carries. */
  readonly partSizeBytes: number;
  /** Injectable clock, for a suite's expiry cases. */
  readonly now?: (() => number) | undefined;
}

export class ObjectStoreUnavailableError extends Error {
  constructor() {
    super('No object store is configured in this deployment (FILE-003)');
    this.name = 'ObjectStoreUnavailableError';
  }
}

/** Every call throws. The honest shape of "this driver does not exist yet". */
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
  openObject(_input: OpenObjectInput): Promise<OpenedObject> {
    return Promise.reject(new ObjectStoreUnavailableError());
  }
  promote(_input: PromoteObjectInput): Promise<Promotion> {
    return Promise.reject(new ObjectStoreUnavailableError());
  }
  withdraw(_input: WithdrawObjectInput): Promise<void> {
    return Promise.reject(new ObjectStoreUnavailableError());
  }
  remove(_input: RemoveObjectInput): Promise<void> {
    return Promise.reject(new ObjectStoreUnavailableError());
  }
}

function moduleFor(store: ObjectStore, sink: PartSink | null): DynamicModule {
  const providers: Provider[] = [{ provide: OBJECT_STORE, useValue: store }];
  if (sink) providers.push({ provide: LOCAL_PART_SINK, useValue: sink });
  return { module: StorageModule, global: true, providers, exports: providers };
}

@Global()
@Module({})
export class StorageModule {
  static forConfig(config: StorageModuleConfig): DynamicModule {
    if (config.driver === 's3') return moduleFor(new UnavailableObjectStore(), null);
    if (config.signingSecret === undefined || config.signingSecret === '') {
      // `packages/config` already refuses this combination at boot; repeated here so a
      // caller that bypassed `loadEnv` fails at wiring time rather than at the first upload.
      throw new Error('STORAGE_DRIVER=filesystem requires STORAGE_LOCAL_SIGNING_SECRET');
    }
    const store = new FilesystemObjectStore({
      root: config.root,
      signingSecret: config.signingSecret,
      publicUrl: config.publicUrl,
      partSizeBytes: config.partSizeBytes,
      ...(config.now ? { now: config.now } : {}),
    });
    return moduleFor(store, store);
  }

  /** A suite's store, held by the suite. No part sink: the fake moves no bytes. */
  static forObjectStore(store: ObjectStore): DynamicModule {
    return moduleFor(store, null);
  }

  /**
   * A suite's *local* store, held by the suite and moving real bytes — the filesystem
   * driver, or a subclass of it with a hook, wired as `forConfig` wires the driver: the
   * same object serves the store and the part sink, so the public PUT lands where the
   * completion will look.
   */
  static forLocalStore(store: ObjectStore & PartSink): DynamicModule {
    return moduleFor(store, store);
  }

  /** No driver at all: the first provider call throws `ObjectStoreUnavailableError`. */
  static none(): DynamicModule {
    return moduleFor(new UnavailableObjectStore(), null);
  }
}
