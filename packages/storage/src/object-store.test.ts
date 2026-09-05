import { describe, expect, it } from 'vitest';
import { FakeObjectStore } from './fake-object-store.js';
import { ObjectNotFoundError } from './errors.js';
import { InvalidObjectKeyComponentError, uploadObjectKey } from './object-key.js';

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
