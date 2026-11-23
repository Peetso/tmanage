import { describe, expect, it } from 'vitest';

import { allDetailsById } from './tool-catalog.js';
import { normalizeArabic, rankActions } from './action-search.js';

const catalogue = [...allDetailsById.entries()].map(([opId, detail]) => ({
  opId,
  title: detail.title,
  description: detail.description,
  ...(detail.descriptionAr !== undefined ? { descriptionAr: detail.descriptionAr } : {}),
}));

const top = (query: string, n = 5) => rankActions(catalogue, query, n).map((a) => a.opId);

// 2026-11-23 live: "create a new project" returned no projects.create, so the AI said it could not.
describe('find actions by plain words', () => {
  it.each([
    ['create a new project', 'projects.create'],
    ['make a project', 'projects.create'],
    ['add a task', 'work_items.create'],
    ['invite an employee', 'invitations.create'],
    ['create a client company', 'client_organizations.create'],
    ["change a member's role", 'members.role.update'],
    ['delete a task', 'work_items.delete'],
    ['start the timer', 'time.timer.start'],
    ['list invoices', 'billing.invoices.list'],
  ])('"%s" finds %s near the top', (query, opId) => {
    expect(top(query)).toContain(opId);
  });

  it('never returns an action that matches no word', () => {
    expect(rankActions(catalogue, 'zzqx', 20)).toEqual([]);
    expect(rankActions(catalogue, '', 20)).toEqual([]);
  });

  it('puts an action matching every word ahead of a partial match', () => {
    const ranked = rankActions(
      [
        { opId: 'documents.create', title: 'Create a document', description: 'In a project.' },
        { opId: 'projects.create', title: 'Create a project', description: '' },
      ],
      'create project',
      2,
    ).map((a) => a.opId);
    expect(ranked[0]).toBe('projects.create');
  });
});

// Fix 8 (live test 2026-11-23 §8): the plain verbs put the area's main action first, not a
// sub-resource (subtasks, forms, tags), the client portal or a platform op.
describe('the main action ranks first on a plain query', () => {
  it.each([
    ['create a task', 'work_items.create'],
    ['add a task', 'work_items.create'],
    ['create a client', 'client_organizations.create'],
    ['write a document', 'documents.create'],
    ['send a chat message', 'conversations.messages.create'],
    ['create an automation rule', 'automations.templates.create'],
    ['assign a task', 'work_items.people.doers.set'],
    ['create a new project', 'projects.create'],
    ['invite an employee', 'invitations.create'],
    ['delete a task', 'work_items.delete'],
    ['cancel a meeting', 'meetings.cancel'],
    ['stop the timer', 'time.timer.stop'],
  ])('"%s" → %s first', (query, opId) => {
    expect(top(query, 1)).toEqual([opId]);
  });

  it('a sub-resource still wins when the query names it', () => {
    expect(top('create a subtask', 1)).toEqual(['work_items.subtasks.create']);
  });
});

// Fix 5 (live test 2026-11-23 §5 G9): every Arabic query returned nothing.
describe('Arabic queries', () => {
  it('folds tashkeel, tatweel, alif forms, taa marbuta and alif maqsura', () => {
    expect(normalizeArabic('أَضِفْ')).toBe('اضف');
    expect(normalizeArabic('إلى')).toBe('الي');
    expect(normalizeArabic('آخر')).toBe('اخر');
    expect(normalizeArabic('مهمـــة')).toBe('مهمه');
  });

  it.each([
    ['اعمل مهمة جديدة', 'work_items.create'],
    ['أضف مهمه', 'work_items.create'],
    ['ضيف تاسك', 'work_items.create'],
    ['اعمل مشروع جديد', 'projects.create'],
    ['انشئ بروجكت', 'projects.create'],
    ['أضف عميل جديد', 'client_organizations.create'],
    ['ضيف كلاينت', 'client_organizations.create'],
    ['عايزك تعمل انفايت لـ موظف', 'invitations.create'],
    ['ادعي موظف', 'invitations.create'],
    ['امسح المهمة', 'work_items.delete'],
    ['احذف التاسك', 'work_items.delete'],
    ['غير صلاحية الموظف', 'members.role.update'],
    ['عدل دور الموظف', 'members.role.update'],
    ['اعمل فاتورة', 'client_invoices.create'],
    ['ابدأ التايمر', 'time.timer.start'],
    ['اعمل اجتماع', 'meetings.create'],
    ['اعمل ميتنج', 'meetings.create'],
    ['ابعت رسالة في الشات', 'conversations.messages.create'],
    ['اعمل قناة شات للمشروع', 'conversations.create'],
    ['اكتب مستند', 'documents.create'],
    ['اعمل دوكيومنت', 'documents.create'],
    ['انقل المهمة', 'work_items.transitions.create'],
    ['سجل مصروف', 'finance.expenses.create'],
  ])('"%s" → %s first', (query, opId) => {
    expect(top(query, 1)).toEqual([opId]);
  });

  it('matches an op by its Arabic description', () => {
    const [hit] = rankActions(
      [
        { opId: 'a.list', title: 'A', description: 'x', descriptionAr: 'الحقائق المعتمدة' },
        { opId: 'b.list', title: 'B', description: 'y' },
      ],
      'الحقائق',
      5,
    );
    expect(hit?.opId).toBe('a.list');
  });
});
