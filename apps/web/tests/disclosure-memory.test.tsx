import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  disclosureKey,
  readDisclosure,
  writeDisclosure,
  type DisclosureStorage,
} from '../src/lib/forms/disclosure-memory';
import { MoreOptions } from '../src/components/forms/MoreOptions';
import { explainAccess } from '../src/lib/access/explain-access';

function memoryStorage(): DisclosureStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe('disclosure memory (55-08)', () => {
  it('remembers "More options" per person and per form', () => {
    const storage = memoryStorage();
    expect(readDisclosure(storage, 'u-1', 'task')).toBe(false);
    writeDisclosure(storage, 'u-1', 'task', true);
    expect(readDisclosure(storage, 'u-1', 'task')).toBe(true);
    expect(readDisclosure(storage, 'u-2', 'task')).toBe(false);
    expect(readDisclosure(storage, 'u-1', 'invoice')).toBe(false);
    expect(disclosureKey(undefined, 'project')).toBe('tm.more-options.v1.anonymous.project');
  });

  it('treats a store that throws as "nothing remembered"', () => {
    const broken: DisclosureStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(readDisclosure(broken, 'u-1', 'task')).toBe(false);
    expect(() => writeDisclosure(broken, 'u-1', 'task', true)).not.toThrow();
  });

  it('keeps the fields mounted while closed and stores the choice when opened', async () => {
    window.localStorage.clear();
    render(
      <MoreOptions form="meeting" userId="u-9" hint="Reminders">
        <label>
          Note
          <input defaultValue="kept" />
        </label>
      </MoreOptions>,
    );
    const toggle = screen.getByRole('button', { name: /More options/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByLabelText('Note', { selector: 'input' })).not.toBeVisible();

    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: /Fewer options/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByLabelText('Note', { selector: 'input' })).toHaveValue('kept');
    expect(window.localStorage.getItem(disclosureKey('u-9', 'meeting'))).toBe('open');
  });
});

describe('access explainer (55-23)', () => {
  const base = {
    kind: 'internal' as const,
    roleLabel: 'Member',
    capabilities: ['work.read'],
    audience: 'internal' as const,
    projectName: 'Website redesign',
    isOwner: false,
    editCapability: 'work.update',
    editCapabilityLabel: 'Edit work',
  };

  it('names the role, the project and who else can see it', () => {
    const result = explainAccess(base);
    expect(result.see.map((reason) => reason.key)).toEqual([
      'AccessExplainer.role',
      'AccessExplainer.project',
      'AccessExplainer.audienceInternal',
    ]);
    expect(result.canEdit).toBe(false);
    expect(result.edit[1]?.key).toBe('AccessExplainer.cannotEdit');
  });

  it('explains a client contact through the shared project, and an editor can edit', () => {
    const result = explainAccess({
      ...base,
      kind: 'client',
      audience: 'client_visible',
      capabilities: ['work.update'],
    });
    expect(result.see.map((reason) => reason.key)).toContain('AccessExplainer.clientShared');
    expect(result.see.at(-1)?.key).toBe('AccessExplainer.audienceClient');
    expect(result.canEdit).toBe(true);
  });
});
