import { describe, expect, it } from 'vitest';
import { usableScanStatus } from './file-download.service.js';
import type { FileVersionRow } from '../../common/database/schema.js';

/** FIX4 item 1b — when a file may be used before (or without) a virus scan. */
const version = (patch: Partial<FileVersionRow>): FileVersionRow =>
  ({
    detectedMimeType: 'image/png',
    scanVerdict: 'clean',
    trustZone: 'private',
    ...patch,
  }) as FileVersionRow;

describe('usableScanStatus', () => {
  it('a scanned, promoted file is clean whatever the policy', () => {
    expect(usableScanStatus('ready', version({}), 'block')).toBe('clean');
  });

  it('a verified file no scanner judged is usable as Not scanned only under allow_labeled', () => {
    const unscanned = version({ scanVerdict: 'unscanned', trustZone: 'quarantine' });
    expect(usableScanStatus('scanning', unscanned, 'allow_labeled')).toBe('not_scanned');
    expect(usableScanStatus('scanning', unscanned, 'block')).toBeNull();
  });

  it('never a file still verifying, infected, rejected or without a version', () => {
    expect(
      usableScanStatus(
        'scanning',
        version({ detectedMimeType: null, scanVerdict: null }),
        'allow_labeled',
      ),
    ).toBeNull();
    expect(
      usableScanStatus('scanning', version({ scanVerdict: 'infected' }), 'allow_labeled'),
    ).toBeNull();
    expect(
      usableScanStatus('rejected', version({ scanVerdict: null }), 'allow_labeled'),
    ).toBeNull();
    expect(
      usableScanStatus('verifying', version({ scanVerdict: null }), 'allow_labeled'),
    ).toBeNull();
    expect(usableScanStatus('scanning', null, 'allow_labeled')).toBeNull();
  });
});
