import { describe, expect, it } from 'vitest';
import { FakeObjectStore } from './fake-object-store.js';
import { ObjectNotFoundError, PromotionClosedError, SizeMismatchError } from './errors.js';
import {
  InvalidObjectKeyComponentError,
  derivativeObjectKey,
  uploadObjectKey,
} from './object-key.js';

const ORG = '019203a4-5b6c-7d8e-9f01-23456789abcd';
const PROJECT = '019203a4-5b6c-7d8e-9f01-23456789abce';
const UPLOAD = '019203a4-5b6c-7d8e-9f01-23456789abcf';

describe('uploadObjectKey', () => {
  it('lays the key out under the tenant, then the project, then the upload (49 §4)', () => {
    expect(uploadObjectKey({ organizationId: ORG, projectId: PROJECT, uploadId: UPLOAD })).toBe(
      `tenant/${ORG}/project/${PROJECT}/upload/${UPLOAD}/object`,
    );
  });

  it('refuses a component that is not a UUID, so a key cannot leave the tenant prefix', () => {
    for (const projectId of ['..', 'x/../..', '', ORG.toUpperCase(), `${PROJECT}/`]) {
      expect(() => uploadObjectKey({ organizationId: ORG, projectId, uploadId: UPLOAD })).toThrow(
        InvalidObjectKeyComponentError,
      );
    }
  });

  it('names the component that failed, and not its value', () => {
    let caught: unknown;
    try {
      uploadObjectKey({ organizationId: ORG, projectId: '../secret', uploadId: UPLOAD });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidObjectKeyComponentError);
    expect((caught as Error).message).not.toContain('secret');
    expect((caught as InvalidObjectKeyComponentError).component).toBe('projectId');
  });
});

describe('FakeObjectStore', () => {
  const key = uploadObjectKey({ organizationId: ORG, projectId: PROJECT, uploadId: UPLOAD });

  it('answers one unreachable URL per part and records what it was asked', async () => {
    const store = new FakeObjectStore(() => 10);
    const upload = await store.beginMultipart({
      zone: 'quarantine',
      objectKey: key,
      partCount: 3,
      declaredBytes: 30,
      expiresInSeconds: 900,
    });
    expect(upload.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    for (const part of upload.parts) expect(part.url.startsWith('memory://')).toBe(true);
    expect(store.began).toHaveLength(1);
    expect(store.began[0]?.zone).toBe('quarantine');
  });

  it('reports the configured size for a key, and the default otherwise', async () => {
    const store = new FakeObjectStore(() => 1_000);
    const base = { zone: 'quarantine' as const, providerUploadId: 'fake-upload-1', parts: [] };
    expect((await store.completeMultipart({ ...base, objectKey: key })).sizeBytes).toBe(1_000);
    store.sizeFor.set(key, 999);
    expect((await store.completeMultipart({ ...base, objectKey: key })).sizeBytes).toBe(999);
  });

  it('throws the configured failure exactly once', async () => {
    const store = new FakeObjectStore(() => 1);
    store.failNext = new Error('provider down');
    const input = { zone: 'quarantine' as const, objectKey: key, providerUploadId: 'x' };
    await expect(store.abortMultipart(input)).rejects.toThrow('provider down');
    await expect(store.abortMultipart(input)).resolves.toBeUndefined();
    expect(store.aborted).toHaveLength(1);
  });
});

describe('FakeObjectStore — openObject (FILE-002)', () => {
  const key = uploadObjectKey({ organizationId: ORG, projectId: PROJECT, uploadId: UPLOAD });

  it('answers the bytes a suite placed under the zone and key, once, with their size', async () => {
    const store = new FakeObjectStore(() => 1);
    store.objects.set(`quarantine/${key}`, Buffer.from('%PDF-1.4 hello'));
    const opened = await store.openObject({ zone: 'quarantine', objectKey: key });
    expect(opened.sizeBytes).toBe(14);
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('%PDF-1.4 hello');
    expect(store.opened).toEqual([{ zone: 'quarantine', objectKey: key }]);
  });

  it('throws ObjectNotFoundError for a key it holds nothing under, and for the same key in another zone', async () => {
    const store = new FakeObjectStore(() => 1);
    store.objects.set(`quarantine/${key}`, Buffer.from('x'));
    await expect(store.openObject({ zone: 'private', objectKey: key })).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
    await expect(
      store.openObject({ zone: 'quarantine', objectKey: `${key}-other` }),
    ).rejects.toBeInstanceOf(ObjectNotFoundError);
    expect(store.opened).toHaveLength(2);
  });

  it('is the provider being down when failNext is set', async () => {
    const store = new FakeObjectStore(() => 1);
    store.objects.set(`quarantine/${key}`, Buffer.from('x'));
    store.failNext = new Error('provider down');
    await expect(store.openObject({ zone: 'quarantine', objectKey: key })).rejects.toThrow(
      'provider down',
    );
    await expect(store.openObject({ zone: 'quarantine', objectKey: key })).resolves.toMatchObject({
      sizeBytes: 1,
    });
  });
});

describe('FakeObjectStore — promote and withdraw (FILE-002 slice B)', () => {
  const key = uploadObjectKey({ organizationId: ORG, projectId: PROJECT, uploadId: UPLOAD });

  async function feed(sink: NodeJS.WritableStream, ...chunks: string[]): Promise<void> {
    for (const chunk of chunks) {
      await new Promise<void>((done, fail) =>
        sink.write(Buffer.from(chunk), (error) => (error ? fail(error) : done())),
      );
    }
  }

  it('places what it was fed under private/key on commit, and records it', async () => {
    const store = new FakeObjectStore(() => 1);
    const promotion = await store.promote({ objectKey: key, sizeBytes: 5 });
    await feed(promotion.sink, 'he', 'llo');
    expect(store.objects.has(`private/${key}`)).toBe(false);
    expect(await promotion.commit()).toMatchObject({ sizeBytes: 5 });
    expect(store.objects.get(`private/${key}`)?.toString()).toBe('hello');
    expect(store.promoted).toEqual([{ objectKey: key, sizeBytes: 5 }]);
    expect(store.committed).toEqual([key]);
    await expect(promotion.commit()).rejects.toBeInstanceOf(PromotionClosedError);
  });

  it('refuses a commit whose bytes are not the declared size', async () => {
    const store = new FakeObjectStore(() => 1);
    const promotion = await store.promote({ objectKey: key, sizeBytes: 4 });
    await feed(promotion.sink, 'hello');
    await expect(promotion.commit()).rejects.toBeInstanceOf(SizeMismatchError);
    expect(store.objects.has(`private/${key}`)).toBe(false);
  });

  it('abort leaves nothing and withdraw removes what a commit placed', async () => {
    const store = new FakeObjectStore(() => 1);
    const aborted = await store.promote({ objectKey: key, sizeBytes: 1 });
    await feed(aborted.sink, 'x');
    await aborted.abort();
    expect(store.objects.has(`private/${key}`)).toBe(false);
    expect(store.abortedPromotions).toEqual([key]);

    const committed = await store.promote({ objectKey: key, sizeBytes: 1 });
    await feed(committed.sink, 'x');
    await committed.commit();
    await store.withdraw({ objectKey: key });
    expect(store.objects.has(`private/${key}`)).toBe(false);
    expect(store.withdrawn).toEqual([key]);
  });
});

describe('derivativeObjectKey (R4 slice 2)', () => {
  const VERSION = '019203a4-5b6c-7d8e-9f01-23456789abd1';
  const PREVIEW = '019203a4-5b6c-7d8e-9f01-23456789abd2';

  it('lays the key out under the tenant, then the version, then the preview row', () => {
    expect(
      derivativeObjectKey({ organizationId: ORG, fileVersionId: VERSION, previewId: PREVIEW }),
    ).toBe(`tenant/${ORG}/derivative/${VERSION}/${PREVIEW}`);
  });

  it('refuses a component that is not a UUID, naming the component only', () => {
    const input = { organizationId: ORG, fileVersionId: VERSION, previewId: PREVIEW };
    for (const [field, value] of [
      ['organizationId', '..'],
      ['fileVersionId', 'a/../b'],
      ['previewId', ''],
    ] as const) {
      let caught: unknown;
      try {
        derivativeObjectKey({ ...input, [field]: value });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(InvalidObjectKeyComponentError);
      expect((caught as InvalidObjectKeyComponentError).component).toBe(field);
    }
  });
});

describe('FakeObjectStore — derivatives (R4 slice 2)', () => {
  const dkey = derivativeObjectKey({
    organizationId: ORG,
    fileVersionId: '019203a4-5b6c-7d8e-9f01-23456789abd1',
    previewId: '019203a4-5b6c-7d8e-9f01-23456789abd2',
  });

  it('keeps a derivative under derived/, reads it back and deletes it', async () => {
    const store = new FakeObjectStore(() => 1);
    const stored = await store.putDerivative({ objectKey: dkey, body: Buffer.from('thumb') });
    expect(stored.sizeBytes).toBe(5);
    expect(store.objects.get(`derived/${dkey}`)?.toString()).toBe('thumb');
    const opened = await store.openDerivative({ objectKey: dkey });
    expect(opened.sizeBytes).toBe(5);
    await store.deleteDerivative({ objectKey: dkey });
    expect(store.objects.has(`derived/${dkey}`)).toBe(false);
    expect(store.derivativesPut).toEqual([dkey]);
    expect(store.derivativesDeleted).toEqual([dkey]);
    await expect(store.openDerivative({ objectKey: dkey })).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
  });

  it('models a provider that refused the write: nothing is stored', async () => {
    const store = new FakeObjectStore(() => 1);
    store.failNext = new Error('down');
    await expect(store.putDerivative({ objectKey: dkey, body: Buffer.from('x') })).rejects.toThrow(
      'down',
    );
    expect(store.objects.size).toBe(0);
  });
});
