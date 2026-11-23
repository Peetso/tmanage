import { describe, expect, it } from 'vitest';
import {
  buildCaptureDraft,
  buildNewWorkPayload,
  defaultSetForProject,
  firstStage,
  initialCaptureProjectId,
  stageFollowUp,
} from '../src/components/work/create/new-work-model';
import type { StageSetView } from '../src/lib/api/work-stages';

/**
 * New work (W-WEB-3), the pure half: the share-target → form mapping, the one create body quick
 * and full create send, and the stage writes a create needs afterwards. The rendered form and its
 * write order are in `new-work-capture.test.tsx`.
 */

describe('buildCaptureDraft', () => {
  it('uses the shared title and keeps separate text and the url for the description', () => {
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

  it('names the work with the shared text when no title is shared, and does not repeat it', () => {
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

describe('buildNewWorkPayload', () => {
  it('sends exactly the project and the trimmed name when nothing else is chosen', () => {
    expect(buildNewWorkPayload({ projectId: 'proj-1', title: '  Draft the brief  ' })).toEqual({
      projectId: 'proj-1',
      title: 'Draft the brief',
    });
  });

  it('reads "tomorrow 3pm" (English or Arabic) out of the name into the due date (B1)', () => {
    const now = new Date(2026, 10, 7, 9, 0); // Saturday 7 Nov 2026, 09:00 local
    const at = (h: number, d = 8): string => new Date(2026, 10, d, h, 0).toISOString();
    expect(buildNewWorkPayload({ projectId: 'p', title: 'Call Sara tomorrow 3pm', now })).toEqual({
      projectId: 'p',
      title: 'Call Sara',
      dueAt: at(15),
    });
    expect(
      buildNewWorkPayload({ projectId: 'p', title: 'اتصل بسارة غداً الساعة 15:00', now }),
    ).toEqual({ projectId: 'p', title: 'اتصل بسارة', dueAt: at(15) });
  });

  it('a picked due day wins over a date written in the name (the words still leave the name)', () => {
    const now = new Date(2026, 10, 7, 9, 0);
    expect(
      buildNewWorkPayload({
        projectId: 'p',
        title: 'Send invoice monday',
        dueDay: '2026-11-20',
        now,
      }),
    ).toEqual({ projectId: 'p', title: 'Send invoice', dueAt: '2026-11-20T12:00:00.000Z' });
  });

  it('carries doers (lead first), supervisor, watchers, client, steps, start and description', () => {
    expect(
      buildNewWorkPayload({
        projectId: 'p',
        title: 'Design the landing page',
        description: '  Hero and sign-up  ',
        doerUserIds: ['u-peter', 'u-sara'],
        supervisorUserIds: ['u-laila'],
        watcherUserIds: ['u-mona'],
        clientOrganizationIds: ['c-nile'],
        steps: ['Collect references', '  ', 'Wireframe '],
        startDay: '2026-11-23',
        dueDay: '2026-12-01',
      }),
    ).toEqual({
      projectId: 'p',
      title: 'Design the landing page',
      description: 'Hero and sign-up',
      startAt: '2026-11-23T12:00:00.000Z',
      dueAt: '2026-12-01T12:00:00.000Z',
      doerUserIds: ['u-peter', 'u-sara'],
      supervisorUserIds: ['u-laila'],
      watcherUserIds: ['u-mona'],
      // Who sees it follows from the client (spec 5.3): a client makes it client-visible.
      audience: 'client_visible',
      clientOrganizationIds: ['c-nile'],
      steps: [{ label: 'Collect references' }, { label: 'Wireframe' }],
    });
  });

  it('a client who must act makes the work client-action-required; no client stays internal', () => {
    expect(
      buildNewWorkPayload({
        projectId: 'p',
        title: 'Approve the copy',
        clientOrganizationIds: ['c-nile'],
        clientAudience: 'client_action_required',
      }),
    ).toMatchObject({ audience: 'client_action_required' });
    expect(
      buildNewWorkPayload({ projectId: 'p', title: 'x', clientAudience: 'client_action_required' }),
    ).not.toHaveProperty('audience');
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

function set(id: string, isDefault: boolean, stageIds: readonly string[]): StageSetView {
  return {
    id,
    name: id,
    scope: 'workspace',
    projectId: null,
    isDefault,
    isBuiltIn: false,
    version: 1,
    stages: stageIds.map((stageId, position) => ({
      id: stageId,
      name: stageId,
      stateKey: position === 0 ? 'ready' : 'in_progress',
      group: position === 0 ? 'not_started' : 'in_progress',
      colorKey: null,
      position,
    })),
    createdAt: null,
    updatedAt: null,
  } as unknown as StageSetView;
}

describe('the stage a new work starts on', () => {
  const simple = set('simple', true, ['s-todo', 's-doing']);
  const design = set('design', false, ['d-empathize', 'd-define']);

  it('uses the project’s set, else the workspace default, and starts on its first stage', () => {
    expect(defaultSetForProject([simple, design], design)?.id).toBe('design');
    expect(defaultSetForProject([design, simple], null)?.id).toBe('simple');
    expect(firstStage(design)?.id).toBe('d-empathize');
    expect(firstStage(null)).toBeNull();
  });

  it('writes nothing after create when the defaults were kept', () => {
    expect(
      stageFollowUp({
        chosenSet: design,
        baseSet: design,
        chosenStage: firstStage(design),
        landedStageId: 'd-empathize',
      }),
    ).toEqual({ stageSetId: null, stage: null });
  });

  it('writes the work’s own set, then moves it, when another set and stage were chosen', () => {
    const define = design.stages[1] ?? null;
    expect(
      stageFollowUp({
        chosenSet: design,
        baseSet: simple,
        chosenStage: define,
        landedStageId: 's-todo',
      }),
    ).toEqual({ stageSetId: 'design', stage: define });
  });
});
