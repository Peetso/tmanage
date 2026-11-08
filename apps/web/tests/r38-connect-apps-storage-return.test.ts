import { describe, expect, it } from 'vitest';
import { readConnectAppsReturn } from '../src/components/screens/ConnectAppsCards';

describe('R38 readConnectAppsReturn — every app comes back to its own card', () => {
  it('reads a Google Drive or OneDrive return as well as a calendar one', () => {
    expect(readConnectAppsReturn('#drive=complete&code=c&state=s')).toEqual({
      kind: 'complete',
      app: 'google_drive',
      code: 'c',
      state: 's',
    });
    expect(readConnectAppsReturn('#onedrive=error&reason=access_denied')).toEqual({
      kind: 'error',
      app: 'onedrive',
    });
    expect(readConnectAppsReturn('#mscal=error')).toEqual({
      kind: 'error',
      app: 'microsoft_calendar',
    });
    expect(readConnectAppsReturn('')).toBeNull();
  });
});
