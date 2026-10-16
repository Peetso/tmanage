import { describe, expect, it } from 'vitest';
import {
  buildCaptureDraft,
  buildCapturePayload,
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
});
