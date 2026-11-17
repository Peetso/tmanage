import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/lib/api/client';
import { setWorkFormAttachments } from '../src/lib/api/work-forms';
import { withIsolates } from '../src/lib/i18n/with-isolates';
import {
  attachmentSettingReady,
  canEditWorkForms,
  savedSetting,
} from '../src/components/screens/WorkFormAttachmentSetting';

// 52-20a owner switch + the visitor's isolated sizes (FIGMA8 673:37507).
describe('52-20a form attachment setting (web)', () => {
  it('sends the project, or null to turn files off', async () => {
    const request = vi.fn(async () => ({ data: { attachmentProjectId: null } }));
    await setWorkFormAttachments({ request } as unknown as ApiClient, 'acme', 'f1', null);
    expect(request).toHaveBeenCalledWith({
      method: 'PUT',
      path: '/v1/organizations/acme/work-forms/f1/attachments',
      body: { projectId: null },
    });
  });

  it('holds Save until a project is chosen, and shows only to roles holding work.create', () => {
    expect(attachmentSettingReady({ enabled: true, projectId: '' })).toBe(false);
    expect(attachmentSettingReady({ enabled: false, projectId: '' })).toBe(true);
    expect(canEditWorkForms('owner')).toBe(true);
    expect(canEditWorkForms(undefined)).toBe(false);
  });

  it('opens on the saved project, or on with "Choose a project" when it is out of reach', () => {
    const live = [{ id: 'p1' }];
    expect(savedSetting({ attachmentProjectId: 'p1' }, live)).toEqual({
      enabled: true,
      projectId: 'p1',
    });
    expect(savedSetting({ attachmentProjectId: 'gone' }, live)).toEqual({
      enabled: true,
      projectId: '',
    });
    expect(savedSetting({ attachmentProjectId: null }, live)).toEqual({
      enabled: false,
      projectId: '',
    });
  });

  it('keeps "25 MB" whole in a left-to-right isolate inside an Arabic sentence', () => {
    const { container } = render(<p>{withIsolates('حتى {size} لكلٍّ منها', { size: '25 MB' })}</p>);
    expect(container.querySelector('bdi[dir="ltr"]')?.textContent).toBe('25 MB');
  });
});
