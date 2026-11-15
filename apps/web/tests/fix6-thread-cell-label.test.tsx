import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useThreadMeta } from '../src/components/viewer/ThreadCard';
import type { ReviewThread } from '../src/lib/api/review';

function thread(anchor: Readonly<Record<string, unknown>> | null): ReviewThread {
  const person = { membershipId: 'm-1', displayName: 'Mona', kind: 'internal' as const };
  return {
    id: 't-1',
    number: 1,
    subjectType: 'file_asset',
    subjectId: 'f-1',
    fileVersionId: null,
    anchorKind: 'cell',
    anchor,
    pageNo: null,
    timeMs: null,
    audience: 'internal',
    status: 'open',
    createdBy: person,
    createdAt: '2026-11-15T10:00:00.000Z',
    resolvedBy: null,
    resolvedAt: null,
    carriedFromThreadId: null,
    comments: [],
    canResolve: true,
    canMove: true,
  };
}

describe('FIX6 item 9: a comment on an Excel cell names the cell', () => {
  it('says "Cell Rates!C7", not "Whole file"', () => {
    const { result } = renderHook(() => useThreadMeta());
    expect(result.current(thread({ sheet: 'Rates', cell: 'C7' }))).toContain('Cell Rates!C7');
  });

  it('falls back to the whole-file word when the anchor has no cell', () => {
    const { result } = renderHook(() => useThreadMeta());
    expect(result.current(thread(null))).not.toContain('Cell');
  });
});
