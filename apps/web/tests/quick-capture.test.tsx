import { describe, expect, it } from 'vitest';
import {
  buildCaptureDraft,
  buildCapturePayload,
  initialCaptureProjectId,
} from '../src/components/screens/QuickCaptureScreen';

/**
 * Quick capture (modules 22/23). The screen's two pure seams, proven without a render: the
 * share-target → form mapping, and the `createWorkItem` body the form sends. The rendered dialog and
 * the create/comment round trip are covered by the screen's own flow test and the API work-items
 * suite; this file pins the share contract and the payload shape.
 */

describe('buildCaptureDraft', () => {
  it('uses the shared title and keeps separate text and the url in the note', () => {
    expect(
      buildCaptureDraft({
        title: 'Launch checklist',
        text: 'Finish the copy pass before Friday',
        url: 'https://example.test/doc/42',
      }),
    ).toEqual({
      title: 'Launch checklist',
      note: 'Finish the copy pass before Friday\n\nhttps://example.test/doc/42',
    });
  });

  it('titles the capture with the shared text when no title is shared, and does not repeat it', () => {
    expect(buildCaptureDraft({ text: 'Call the supplier back' })).toEqual({
      title: 'Call the supplier back',
      note: '',
    });
  });

  it('produces an empty draft from an empty / missing payload', () => {
    expect(buildCaptureDraft({})).toEqual({ title: '', note: '' });
    expect(buildCaptureDraft({ title: null, text: null, url: null })).toEqual({
      title: '',
      note: '',
    });
  });
});

describe('buildCapturePayload', () => {
  it('builds the create body from the chosen project and trimmed title only', () => {
    expect(buildCapturePayload({ projectId: 'proj-1', title: '  Draft the brief  ' })).toEqual({
      projectId: 'proj-1',
      title: 'Draft the brief',
    });
  });

  it('adds the owner and committed day picked on the chips (2026-10-31 live test)', () => {
    expect(
      buildCapturePayload({
        projectId: 'proj-1',
        title: 'Draft',
        ownerUserId: 'u-1',
        committedDay: '2026-11-02',
      }),
    ).toEqual({
      projectId: 'proj-1',
      title: 'Draft',
      ownerUserId: 'u-1',
      dueAt: '2026-11-02T12:00:00.000Z',
    });
    expect(
      buildCapturePayload({ projectId: 'p', title: 'x', ownerUserId: null, committedDay: '' }),
    ).toEqual({ projectId: 'p', title: 'x' });
  });
});

describe('initialCaptureProjectId (WRK-09)', () => {
  const available = [{ id: 'proj-a' }, { id: 'proj-b' }];

  it('opens on the handed-over project when it is one of the caller’s', () => {
    expect(initialCaptureProjectId(available, 'proj-b')).toBe('proj-b');
  });

  it('does not preselect the first project when nothing was handed over', () => {
    expect(initialCaptureProjectId(available)).toBe('');
  });

  it('ignores a handed-over project the caller cannot see', () => {
    expect(initialCaptureProjectId(available, 'proj-elsewhere')).toBe('');
  });
});
