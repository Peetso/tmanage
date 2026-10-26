import { afterEach, describe, expect, it } from 'vitest';
import { openDrivePicker } from '../src/lib/google-picker';

/**
 * Live bug 2026-10-26: "Change folder" opened an empty picker. One DocsView with
 * `setEnableDrives(true)` is Google's Shared drives view, so My Drive never showed. The picker
 * must offer My Drive (from its root, folders included) and Shared drives as separate views.
 */

type Call = readonly [string, unknown];

class FakeDocsView {
  readonly calls: Call[] = [];
  constructor(readonly viewId: unknown) {}
  setIncludeFolders(on: boolean) {
    this.calls.push(['setIncludeFolders', on]);
    return this;
  }
  setSelectFolderEnabled(on: boolean) {
    this.calls.push(['setSelectFolderEnabled', on]);
    return this;
  }
  setEnableDrives(on: boolean) {
    this.calls.push(['setEnableDrives', on]);
    return this;
  }
  setMimeTypes(types: string) {
    this.calls.push(['setMimeTypes', types]);
    return this;
  }
  setParent(parentId: string) {
    this.calls.push(['setParent', parentId]);
    return this;
  }
  setOwnedByMe(on: boolean) {
    this.calls.push(['setOwnedByMe', on]);
    return this;
  }
}

function installFakePicker() {
  const views: FakeDocsView[] = [];
  const features: unknown[] = [];
  const builderCalls: Call[] = [];
  let callback: ((data: Record<string, unknown>) => void) | null = null;
  class FakeBuilder {
    addView(view: FakeDocsView) {
      views.push(view);
      return this;
    }
    enableFeature(feature: unknown) {
      features.push(feature);
      return this;
    }
    setOAuthToken(v: string) {
      builderCalls.push(['setOAuthToken', v]);
      return this;
    }
    setDeveloperKey(v: string) {
      builderCalls.push(['setDeveloperKey', v]);
      return this;
    }
    setAppId(v: string) {
      builderCalls.push(['setAppId', v]);
      return this;
    }
    setLocale(v: string) {
      builderCalls.push(['setLocale', v]);
      return this;
    }
    setTitle(v: string) {
      builderCalls.push(['setTitle', v]);
      return this;
    }
    setCallback(cb: (data: Record<string, unknown>) => void) {
      callback = cb;
      return this;
    }
    build() {
      return { setVisible: () => undefined };
    }
  }
  window.google = {
    picker: {
      PickerBuilder: FakeBuilder,
      DocsView: FakeDocsView,
      ViewId: { DOCS: 'DOCS', FOLDERS: 'FOLDERS' },
      Feature: { MULTISELECT_ENABLED: 'MULTI', SUPPORT_DRIVES: 'DRIVES' },
      Action: { PICKED: 'picked', CANCEL: 'cancel' },
      Response: { ACTION: 'action', DOCUMENTS: 'docs' },
      Document: { ID: 'id', NAME: 'name' },
    } as never,
  };
  return {
    views,
    features,
    builderCalls,
    fire: (data: Record<string, unknown>) => callback?.(data),
  };
}

const base = { accessToken: 'tok', apiKey: 'key', appId: '1234567890', locale: 'en', title: 'T' };

async function open(mode: 'files' | 'folder') {
  const fake = installFakePicker();
  const result = openDrivePicker({ ...base, mode });
  await Promise.resolve();
  await Promise.resolve();
  return { fake, result };
}

describe('Drive picker views', () => {
  afterEach(() => {
    delete window.google;
  });

  it('folder mode: a My Drive view from the root, and a separate Shared drives view', async () => {
    const { fake, result } = await open('folder');
    expect(fake.views).toHaveLength(2);
    const [myDrive, shared] = fake.views;
    for (const view of [myDrive, shared]) {
      expect(view?.viewId).toBe('FOLDERS');
      expect(view?.calls).toContainEqual(['setIncludeFolders', true]);
      expect(view?.calls).toContainEqual(['setSelectFolderEnabled', true]);
      expect(view?.calls).toContainEqual(['setMimeTypes', 'application/vnd.google-apps.folder']);
    }
    expect(myDrive?.calls).toContainEqual(['setParent', 'root']);
    expect(myDrive?.calls.some(([name]) => name === 'setEnableDrives')).toBe(false);
    expect(shared?.calls).toContainEqual(['setEnableDrives', true]);
    expect(fake.features).toEqual(['DRIVES']);
    expect(fake.builderCalls).toContainEqual(['setAppId', '1234567890']);

    fake.fire({ action: 'picked', docs: [{ id: 'folder_123', name: 'Clients' }] });
    await expect(result).resolves.toEqual([{ id: 'folder_123', name: 'Clients' }]);
  });

  it('files mode: My Drive and Shared drives, multi-select, no folder-only filter', async () => {
    const { fake, result } = await open('files');
    expect(fake.views).toHaveLength(2);
    const [myDrive, shared] = fake.views;
    expect(myDrive?.calls).toContainEqual(['setParent', 'root']);
    expect(myDrive?.calls).toContainEqual(['setIncludeFolders', true]);
    expect(shared?.calls).toContainEqual(['setEnableDrives', true]);
    for (const view of [myDrive, shared]) {
      expect(view?.calls.some(([name]) => name === 'setMimeTypes')).toBe(false);
    }
    expect(fake.features).toEqual(['DRIVES', 'MULTI']);

    fake.fire({ action: 'cancel' });
    await expect(result).resolves.toEqual([]);
  });
});
