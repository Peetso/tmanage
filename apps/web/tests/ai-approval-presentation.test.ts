import { describe, expect, it } from 'vitest';
import {
  clientInitial,
  fieldLabel,
  fillTemplate,
  formatCountdown,
  localizedFieldLabel,
  localizedOpTitle,
  readableFields,
  subjectLine,
} from '../src/lib/ai-approval-presentation';
import { safeReturnPath } from '../src/lib/sign-in-return';

describe('AI approve page presentation (S10)', () => {
  it('formats the expiry countdown as m:ss and never goes negative', () => {
    expect(formatCountdown(581_000)).toBe('9:41');
    expect(formatCountdown(600_000)).toBe('10:00');
    expect(formatCountdown(-5)).toBe('0:00');
  });

  it('turns argument keys into readable labels', () => {
    expect(fieldLabel('workItemId')).toBe('Work item');
    expect(fieldLabel('due_date')).toBe('Due date');
    expect(fieldLabel('id')).toBe('Id');
  });

  it('fills catalog placeholders and the client initial', () => {
    expect(fillTemplate('{client} asked for {name}', { client: 'Claude', name: 'Maya' })).toBe(
      'Claude asked for Maya',
    );
    expect(fillTemplate('{missing}', {})).toBe('{missing}');
    expect(clientInitial(' claude')).toBe('C');
  });

  it('lets sign-in return to an approve link, and to nothing that only looks like one', () => {
    const link = '/studio/ai/approve/01890000-0000-7000-8000-000000000001';
    expect(safeReturnPath(link)).toBe(link);
    expect(safeReturnPath('//evil.test/ai/approve/01890000-0000-7000-8000-000000000001')).toBe(
      '/organizations',
    );
    expect(safeReturnPath(`${link}?next=https://evil.test`)).toBe('/organizations');
  });

  it('renders op titles and field names through the catalog by id, keeping English as fallback', () => {
    const ar: Record<string, string> = {
      'aiApprove.op.work_items.delete': 'حذف عنصر',
      'aiApprove.field.workItemId': 'العنصر',
      'aiApprove.subjectDelete': 'حذف «{name}»',
    };
    const lookup = (key: string): string | undefined => ar[key];
    expect(localizedOpTitle(lookup, 'work_items.delete', 'Delete work item')).toBe('حذف عنصر');
    expect(localizedOpTitle(lookup, 'x.unknown', 'Do a thing')).toBe('Do a thing');
    expect(localizedFieldLabel(lookup, 'workItemId')).toBe('العنصر');
    expect(localizedFieldLabel(lookup, 'due_date')).toBe('Due date');
  });

  it('builds the bold subject line, localized, and nothing without a subject', () => {
    const none = (): undefined => undefined;
    expect(subjectLine(none, 'Homepage direction review', true)).toBe(
      'Delete “Homepage direction review”',
    );
    expect(subjectLine(none, 'sam@x.test', false)).toBe('“sam@x.test”');
    expect(subjectLine(() => 'حذف «{name}»', 'مراجعة', true)).toBe('حذف «مراجعة»');
    expect(subjectLine(none, null, true)).toBeNull();
  });

  it('shows only the argument rows a person can read, never a raw id (TESTUX P2 30)', () => {
    const fields = [
      { name: 'workItemId', value: '0198f4a2-1c00-7000-8000-00000000000d' },
      { name: 'memberIds', value: '["0198…"]' },
      { name: 'title', value: 'Homepage' },
      { name: 'paid', value: 'true' },
    ];
    expect(readableFields(fields).map((field) => field.name)).toEqual(['title', 'paid']);
  });
});
