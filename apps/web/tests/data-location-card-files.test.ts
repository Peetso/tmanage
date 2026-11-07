import { describe, expect, it } from 'vitest';
import { filesLocationOf } from '../src/components/screens/DataLocationCard';

/** B12 — the Data location card's Files row names the configured storage, not a fixed Drive. */
describe('filesLocationOf', () => {
  const tr = (_key: string, english: string) => english;

  it('names the configured provider and never claims Drive for TManage storage', () => {
    expect(filesLocationOf('tmanage', tr)).toMatch(/^TManage storage/);
    expect(filesLocationOf('google_drive', tr)).toMatch(/^Google Drive/);
    expect(filesLocationOf('onedrive', tr)).toMatch(/^OneDrive/);
    expect(filesLocationOf(undefined, tr)).toBe('—');
  });
});
