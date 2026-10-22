/**
 * The Google Picker — Google's own file chooser, used for "Attach from Google Drive" and for
 * "Change folder" on the Storage screen. With the `drive.file` scope, picking a file is what grants
 * TManage access to it; TManage never browses the Drive itself.
 *
 * The script is Google's (`apis.google.com/js/api.js`), loaded once on first use, never at page
 * load. Everything here runs only in the browser.
 */

const API_SCRIPT = 'https://apis.google.com/js/api.js';

export interface PickedDriveItem {
  readonly id: string;
  readonly name: string;
}

export interface PickerOptions {
  readonly accessToken: string;
  readonly apiKey: string;
  readonly appId: string | null;
  /** `files` (attach) or `folder` (choose where TManage keeps files, Shared Drives included). */
  readonly mode: 'files' | 'folder';
  readonly locale: string;
  readonly title: string;
}

interface PickerBuilder {
  addView(view: unknown): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setLocale(locale: string): PickerBuilder;
  setTitle(title: string): PickerBuilder;
  enableFeature(feature: unknown): PickerBuilder;
  setCallback(callback: (data: Record<string, unknown>) => void): PickerBuilder;
  build(): { setVisible(visible: boolean): void };
}

interface GooglePickerNamespace {
  PickerBuilder: new () => PickerBuilder;
  DocsView: new (viewId?: unknown) => {
    setIncludeFolders(on: boolean): unknown;
    setSelectFolderEnabled(on: boolean): unknown;
    setEnableDrives(on: boolean): unknown;
    setMimeTypes(types: string): unknown;
  };
  ViewId: { DOCS: unknown; FOLDERS: unknown };
  Feature: { MULTISELECT_ENABLED: unknown; SUPPORT_DRIVES: unknown };
  Action: { PICKED: string; CANCEL: string };
  Response: { ACTION: string; DOCUMENTS: string };
  Document: { ID: string; NAME: string };
}

declare global {
  interface Window {
    gapi?: { load(name: string, callback: () => void): void };
    google?: { picker?: GooglePickerNamespace };
  }
}

let loading: Promise<GooglePickerNamespace> | null = null;

function loadPicker(): Promise<GooglePickerNamespace> {
  if (window.google?.picker) return Promise.resolve(window.google.picker);
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = API_SCRIPT;
    script.async = true;
    script.onerror = () => {
      loading = null;
      reject(new Error('picker_unavailable'));
    };
    script.onload = () => {
      window.gapi?.load('picker', () => {
        if (window.google?.picker) resolve(window.google.picker);
        else reject(new Error('picker_unavailable'));
      });
    };
    document.head.appendChild(script);
  });
  return loading;
}

/** Open the picker; resolves with what the person chose, or an empty list on cancel. */
export async function openDrivePicker(options: PickerOptions): Promise<readonly PickedDriveItem[]> {
  const picker = await loadPicker();
  return new Promise((resolve) => {
    const view = new picker.DocsView(options.mode === 'folder' ? picker.ViewId.FOLDERS : undefined);
    view.setEnableDrives(true);
    if (options.mode === 'folder') {
      view.setIncludeFolders(true);
      view.setSelectFolderEnabled(true);
      view.setMimeTypes('application/vnd.google-apps.folder');
    }
    let builder = new picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(options.accessToken)
      .setDeveloperKey(options.apiKey)
      .setLocale(options.locale)
      .setTitle(options.title)
      .enableFeature(picker.Feature.SUPPORT_DRIVES)
      .setCallback((data) => {
        const action = data[picker.Response.ACTION];
        if (action === picker.Action.CANCEL) resolve([]);
        if (action !== picker.Action.PICKED) return;
        const docs =
          (data[picker.Response.DOCUMENTS] as Record<string, unknown>[] | undefined) ?? [];
        resolve(
          docs
            .map((doc) => ({
              id: String(doc[picker.Document.ID] ?? ''),
              name: String(doc[picker.Document.NAME] ?? ''),
            }))
            .filter((doc) => doc.id !== ''),
        );
      });
    if (options.mode === 'files')
      builder = builder.enableFeature(picker.Feature.MULTISELECT_ENABLED);
    if (options.appId) builder = builder.setAppId(options.appId);
    builder.build().setVisible(true);
  });
}
