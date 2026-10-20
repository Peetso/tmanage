import { describe, expect, it } from 'vitest';
import { fileAvailabilityFor } from './item-files.service.js';

/**
 * WRK-04: an attachment the member may read carries a typed availability so the row shows a
 * "being checked" state for a file still scanning, rather than linking to a raw-JSON refusal.
 * `fileAvailabilityFor` is that mapping from the asset's upload status.
 */
describe('fileAvailabilityFor', () => {
  it('is ready only when the file is ready to serve', () => {
    expect(fileAvailabilityFor('ready')).toBe('ready');
  });

  it('is scanning for every state before a verdict', () => {
    for (const status of ['created', 'uploading', 'uploaded', 'verifying', 'scanning']) {
      expect(fileAvailabilityFor(status)).toBe('scanning');
    }
  });

  it('is unavailable once the file is rejected, expired or cancelled', () => {
    for (const status of ['rejected', 'expired', 'cancelled']) {
      expect(fileAvailabilityFor(status)).toBe('unavailable');
    }
  });
});
