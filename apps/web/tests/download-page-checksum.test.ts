import { describe, expect, it } from 'vitest';
import { parseSha256 } from '../src/components/website/pages/download/installer-checksum';

describe('download page checksum (51-10a)', () => {
  it('reads the hex from a sha256sum line and refuses anything else', () => {
    const hex = 'AB'.repeat(32);
    expect(parseSha256(`${hex}  TManage-Setup.exe\n`)).toBe(hex.toLowerCase());
    expect(parseSha256('<html>not found</html>')).toBeUndefined();
  });
});
