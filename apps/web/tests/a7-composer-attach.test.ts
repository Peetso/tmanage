import { describe, expect, it } from 'vitest';
import { addPendingFiles } from '../src/components/chat/pane/Composer';
import { MAX_ATTACHMENTS } from '../src/lib/api/uploads';

/** A7: the channel composer's pending-file list — admitted files kept, refused ones explained. */
function file(name: string, size: number, type: string): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe('addPendingFiles', () => {
  it('keeps admitted files and reports the first refused one', () => {
    const pdf = file('brief.pdf', 10, 'application/pdf');
    const empty = file('empty.pdf', 0, 'application/pdf');
    const exe = file('setup.exe', 10, 'application/x-msdownload');
    const result = addPendingFiles([], [pdf, empty, exe]);
    expect(result.files).toEqual([pdf]);
    expect(result.problem).toContain('empty.pdf');
    expect(result.tooMany).toBe(false);
  });

  it('stops at the per-message limit', () => {
    const many = Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, index) =>
      file(`n${index}.txt`, 4, 'text/plain'),
    );
    const result = addPendingFiles([], many);
    expect(result.files).toHaveLength(MAX_ATTACHMENTS);
    expect(result.tooMany).toBe(true);
  });
});
