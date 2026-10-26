/**
 * Microsoft's OneDrive File Picker v8 — "Attach from OneDrive" and "Change folder" on the Storage
 * screen. The picker is Microsoft's own page in a popup: TManage POSTs the options and a resource
 * token to it, then talks to it over a `MessageChannel` (`initialize` -> `activate`; the picker
 * sends `authenticate`, `pick` and `close` commands, each acknowledged and answered).
 *
 * Personal accounts open `https://onedrive.live.com/picker`; work and school accounts open
 * `<their SharePoint>/_layouts/15/FilePicker.aspx`, starting in SharePoint when libraries are on.
 * Everything here runs only in the browser; the pure parts are exported for tests.
 */

export interface PickedOneDriveItem {
  readonly driveId: string;
  readonly itemId: string;
  readonly name: string;
  readonly size: number | null;
  readonly webUrl: string | null;
}

export interface OneDrivePickerSession {
  readonly accessToken: string;
  readonly accountType: 'personal' | 'business';
  readonly baseUrl: string;
  readonly librariesEnabled: boolean;
}

export type OneDrivePickerMode = 'files' | 'folder';

const CHANNEL_ID = 'tmanage-onedrive';
const WINDOW_NAME = 'tmanage-onedrive-picker';

/** The `filePicker` options Microsoft's page reads. Pure. */
export function buildPickerOptions(
  session: Pick<OneDrivePickerSession, 'accountType' | 'baseUrl' | 'librariesEnabled'>,
  mode: OneDrivePickerMode,
  origin: string,
): Record<string, unknown> {
  const sharePoint = session.accountType === 'business' && session.librariesEnabled;
  return {
    sdk: '8.0',
    entry: sharePoint
      ? {
          sharePoint: {
            byPath: { web: session.baseUrl.replace('-my.sharepoint.com', '.sharepoint.com') },
          },
        }
      : { oneDrive: { files: {} } },
    authentication: {},
    messaging: { origin, channelId: CHANNEL_ID },
    typesAndSources: {
      mode: mode === 'folder' ? 'folders' : 'files',
      pivots: { oneDrive: true, recent: mode === 'files', sharedLibraries: sharePoint },
    },
    selection: { mode: mode === 'folder' ? 'single' : 'multiple' },
  };
}

/** Where the options are POSTed. Pure. */
export function pickerUrl(
  session: Pick<OneDrivePickerSession, 'accountType' | 'baseUrl'>,
  options: Record<string, unknown>,
  locale: string,
): string {
  const query = new URLSearchParams({
    filePicker: JSON.stringify(options),
    locale: locale === 'ar' ? 'ar-sa' : 'en-us',
  });
  const base =
    session.accountType === 'personal'
      ? session.baseUrl
      : `${session.baseUrl.replace(/\/+$/, '')}/_layouts/15/FilePicker.aspx`;
  return `${base}?${query.toString()}`;
}

/** The items of a `pick` command, reduced to what TManage stores. Pure. */
export function readPickedItems(items: unknown): readonly PickedOneDriveItem[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((raw: unknown) => {
    const item = raw as {
      id?: unknown;
      name?: unknown;
      size?: unknown;
      webUrl?: unknown;
      parentReference?: { driveId?: unknown };
    };
    const driveId = item.parentReference?.driveId;
    if (typeof item.id !== 'string' || typeof driveId !== 'string') return [];
    return [
      {
        driveId,
        itemId: item.id,
        name: typeof item.name === 'string' ? item.name : item.id,
        size: typeof item.size === 'number' ? item.size : null,
        webUrl: typeof item.webUrl === 'string' ? item.webUrl : null,
      },
    ];
  });
}

/**
 * Open the popup now, inside the click, so it is not blocked; the picker is loaded into it once
 * the session arrives. Null when the browser refused the popup.
 */
export function reservePickerWindow(): Window | null {
  return window.open('', WINDOW_NAME, 'width=1080,height=680');
}

export interface OpenOneDrivePickerOptions {
  readonly popup: Window;
  readonly session: OneDrivePickerSession;
  readonly mode: OneDrivePickerMode;
  readonly locale: string;
  /** A business picker may ask a token for another SharePoint origin (a library's site). */
  readonly tokenFor: (resource: string) => Promise<string>;
}

/** Run the picker in `popup`; resolves with what the person chose, or an empty list on close. */
export function openOneDrivePicker({
  popup,
  session,
  mode,
  locale,
  tokenFor,
}: OpenOneDrivePickerOptions): Promise<readonly PickedOneDriveItem[]> {
  const options = buildPickerOptions(session, mode, window.location.origin);
  const form = popup.document.createElement('form');
  form.setAttribute('action', pickerUrl(session, options, locale));
  form.setAttribute('method', 'POST');
  const token = popup.document.createElement('input');
  token.setAttribute('type', 'hidden');
  token.setAttribute('name', 'access_token');
  token.setAttribute('value', session.accessToken);
  form.appendChild(token);
  popup.document.body.appendChild(form);
  form.submit();

  return new Promise((resolve) => {
    let port: MessagePort | null = null;
    let settled = false;
    const finish = (items: readonly PickedOneDriveItem[]) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onWindowMessage);
      window.clearInterval(watch);
      port?.close();
      if (!popup.closed) popup.close();
      resolve(items);
    };
    // The person may close the popup with the window's own button; no command says so.
    const watch = window.setInterval(() => {
      if (popup.closed) finish([]);
    }, 500);

    const answer = (id: unknown, data: Record<string, unknown>) =>
      port?.postMessage({ type: 'result', id, data });

    const onPortMessage = async (event: MessageEvent) => {
      const message = event.data as { type?: unknown; id?: unknown; data?: unknown };
      if (message.type !== 'command') return;
      port?.postMessage({ type: 'acknowledge', id: message.id });
      const command = (message.data ?? {}) as {
        command?: unknown;
        resource?: unknown;
        items?: unknown;
      };
      if (command.command === 'authenticate') {
        try {
          const resource = typeof command.resource === 'string' ? command.resource : '';
          const sameOrigin =
            session.accountType === 'personal' ||
            resource === '' ||
            resource.replace(/\/+$/, '') === session.baseUrl.replace(/\/+$/, '');
          const value = sameOrigin ? session.accessToken : await tokenFor(resource);
          answer(message.id, { result: 'token', token: value });
        } catch {
          answer(message.id, {
            result: 'error',
            error: { code: 'unableToObtainToken', message: 'No token' },
          });
        }
      } else if (command.command === 'pick') {
        answer(message.id, { result: 'success' });
        finish(readPickedItems(command.items));
      } else if (command.command === 'close') {
        finish([]);
      } else {
        answer(message.id, {
          result: 'error',
          error: { code: 'unsupportedCommand', message: String(command.command) },
        });
      }
    };

    function onWindowMessage(event: MessageEvent) {
      if (event.source !== popup) return;
      const message = event.data as { type?: unknown; channelId?: unknown };
      if (message.type !== 'initialize' || message.channelId !== CHANNEL_ID) return;
      const [received] = event.ports;
      if (!received) return;
      port = received;
      port.addEventListener('message', (inner) => void onPortMessage(inner));
      port.start();
      port.postMessage({ type: 'activate' });
    }
    window.addEventListener('message', onWindowMessage);
  });
}
