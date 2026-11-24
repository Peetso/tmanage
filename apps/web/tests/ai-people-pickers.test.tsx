import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PeoplePickerDialog } from '../src/components/work/WorkPeopleBlock';
import type { OwnerCandidate } from '../src/components/work/OwnerPickerDialog';
import { MentionPicker, type MentionOption } from '../src/components/chat/MentionPicker';
import { aiActorOf, WorkActivityWho } from '../src/components/work/detail/WorkActivityWho';
import type { MemberSummary } from '../src/lib/api/members';
import type { WorkActivityEntry } from '../src/lib/api/work-activity';
import { aiInitialsOf } from '../src/components/ai-employees/AiBadge';
import { expectNoAxeViolations } from './axe';

/**
 * 60-08 (plan 60 v2 S7, Figma AI-S7a/S7b/S7c/S7d) — AI employees in the Work people pickers, the
 * @mention picker and the Activity tab: the "AI employees" section after People, an unavailable
 * row dimmed with its reason, one AI employee per task, the Supervisor picker that never lists AI
 * employees, and the AI mark on an activity entry. Each also in a right-to-left page.
 */

const mark = (availability: 'available' | 'paused' | 'not_connected' | 'switched_off') => ({
  jobTitle: 'Content writer',
  status: availability === 'paused' ? ('paused' as const) : ('active' as const),
  connected: availability !== 'not_connected',
  availability,
});

const CANDIDATES: readonly OwnerCandidate[] = [
  { userId: 'u-sara', displayName: 'Sara Adel', subtitle: 'Manager' },
  { userId: 'u-peter', displayName: 'Peter Khalil', subtitle: 'Owner' },
  {
    userId: 'u-mat',
    displayName: 'Mat',
    subtitle: 'Content writer',
    kind: 'ai',
    ai: mark('available'),
  },
  {
    userId: 'u-nour',
    displayName: 'Nour',
    subtitle: 'Researcher',
    kind: 'ai',
    ai: { ...mark('available'), jobTitle: 'Researcher' },
  },
  { userId: 'u-zed', displayName: 'Zed', kind: 'ai', ai: mark('not_connected') },
  { userId: 'u-pia', displayName: 'Pia', kind: 'ai', ai: mark('paused') },
];

function picker(props: Partial<Parameters<typeof PeoplePickerDialog>[0]> = {}) {
  const onSave = vi.fn();
  const view = render(
    <PeoplePickerDialog
      title="Choose doers"
      projectName="Atlas relaunch"
      candidates={CANDIDATES}
      loading={false}
      initial={[]}
      showLeadHint
      saving={false}
      onSave={onSave}
      onClose={() => undefined}
      {...props}
    />,
  );
  return { ...view, onSave };
}

const aiList = () => screen.getByRole('list', { name: 'AI employees' });

describe('60-08: the Doers picker offers AI employees in their own section (S7a)', () => {
  it('lists people first, then the AI employees, each marked; no axe violations', async () => {
    const { container } = picker({ ai: 'offer' });
    const people = screen.getByRole('list', { name: 'People' });
    expect(within(people).getAllByRole('checkbox')).toHaveLength(2);
    expect(within(aiList()).getAllByRole('checkbox')).toHaveLength(4);
    // The people heading comes before the AI heading in reading order.
    const headings = [...container.querySelectorAll('.tm-ai-pick__heading')].map(
      (node) => node.textContent,
    );
    expect(headings).toEqual(['People', 'AI employees']);
    expect(within(aiList()).getAllByText('AI employee')).toHaveLength(4);
    expect(screen.getByRole('searchbox', { name: 'Search people, teams or AI' })).toBeTruthy();
    await expectNoAxeViolations(container);
  });

  it('dims an AI employee who cannot take work now, says why, and does not tick him', async () => {
    picker({ ai: 'offer' });
    const zed = within(aiList()).getAllByTestId('ai-candidate')[2] as HTMLElement;
    const pia = within(aiList()).getAllByTestId('ai-candidate')[3] as HTMLElement;
    expect(zed.getAttribute('aria-disabled')).toBe('true');
    expect(within(zed).getByText('Not connected')).toBeTruthy();
    expect(within(pia).getByText('Paused')).toBeTruthy();
    // The reason replaces the job line, and keeps the full muted colour (not dimmed).
    expect(within(zed).queryByText('Content writer')).toBeNull();
    expect(within(zed).getByText('Not connected').closest('.tm-ai-pick__dim')).toBeNull();
    await userEvent.click(zed);
    expect(zed.getAttribute('aria-checked')).toBe('false');
  });

  it('keeps one AI employee per task: ticking a second one unticks the first', async () => {
    const { onSave } = picker({ ai: 'offer' });
    const [mat, nour] = within(aiList()).getAllByTestId('ai-candidate') as HTMLElement[];
    await userEvent.click(screen.getByRole('checkbox', { name: /Sara Adel/ }));
    await userEvent.click(mat as HTMLElement);
    await userEvent.click(nour as HTMLElement);
    expect(mat?.getAttribute('aria-checked')).toBe('false');
    expect(nour?.getAttribute('aria-checked')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSave).toHaveBeenCalledWith(['u-sara', 'u-nour']);
  });

  it('hides the AI section from someone who may not give work to AI employees', () => {
    picker({ ai: 'offer', canAssignAi: false });
    expect(screen.queryByRole('list', { name: 'AI employees' })).toBeNull();
  });

  it('never offers AI employees in the Watchers picker (no ai prop)', () => {
    picker();
    expect(screen.queryAllByTestId('ai-candidate')).toHaveLength(0);
    expect(screen.queryByText('People')).toBeNull();
  });
});

describe('60-08: the Supervisor picker lists people only (S7b)', () => {
  it('says AI employees cannot supervise, and lists no AI employee', async () => {
    const { container } = picker({ ai: 'refuse', title: 'Choose supervisors' });
    expect(screen.queryAllByTestId('ai-candidate')).toHaveLength(0);
    expect(screen.getByTestId('ai-cant-supervise').textContent).toBe(
      'AI employees can’t supervise.',
    );
    expect(screen.getByRole('searchbox', { name: 'Search people' })).toBeTruthy();
    await expectNoAxeViolations(container);
  });

  it('keeps Done off until a person is ticked when an AI employee does the work', async () => {
    picker({ ai: 'refuse', requirePerson: true });
    const done = screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: /Peter Khalil/ }));
    expect(done.disabled).toBe(false);
  });

  it('reads the same in a right-to-left page: People first, then the note; no axe violations', async () => {
    const { container } = render(
      <div dir="rtl" lang="ar">
        <PeoplePickerDialog
          title="Choose supervisors"
          projectName="Atlas relaunch"
          candidates={CANDIDATES}
          loading={false}
          initial={['u-peter']}
          showLeadHint={false}
          saving={false}
          onSave={() => undefined}
          onClose={() => undefined}
          ai="refuse"
          requirePerson
        />
      </div>,
    );
    const people = screen.getByRole('list', { name: 'People' });
    const note = screen.getByTestId('ai-cant-supervise');
    expect(people.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    await expectNoAxeViolations(container);
  });
});

describe('60-08: the @mention picker has an AI employees section (S7d)', () => {
  const options: MentionOption[] = [
    { userId: 'u-sara', displayName: 'Sara Adel', mention: '@u-sara', group: 'others' },
    {
      userId: 'u-mat',
      displayName: 'Mat',
      mention: '@u-mat',
      group: 'ai',
      subtitle: 'Content writer',
    },
  ];

  it('puts the AI employee after the people, with his mark and job line', async () => {
    const { container } = render(
      <div dir="rtl">
        <MentionPicker
          id="mention"
          options={options}
          activeIndex={1}
          onPick={() => undefined}
          onHover={() => undefined}
          othersHeading="People who can see this task"
          aiHeading="AI employees"
        />
      </div>,
    );
    const groups = screen.getAllByRole('group');
    expect(groups.map((group) => group.getAttribute('aria-labelledby') !== null)).toEqual([
      true,
      true,
    ]);
    const ai = groups[1] as HTMLElement;
    expect(within(ai).getByText('AI employees')).toBeTruthy();
    const mat = within(ai).getByRole('option');
    expect(mat.getAttribute('aria-selected')).toBe('true');
    expect(within(mat).getByText('AI employee')).toBeTruthy();
    expect(within(mat).getByText('Content writer')).toBeTruthy();
    expect(mat.id).toBe('mention-1');
    await expectNoAxeViolations(container);
  });
});

describe('60-08: the Activity tab names the AI employee who did it (S7c pattern)', () => {
  const members: MemberSummary[] = [
    { userId: 'u-sara', displayName: 'Sara Adel', role: 'manager', kind: 'human' },
    {
      userId: 'u-mat',
      displayName: 'Mat',
      role: 'member',
      kind: 'ai',
      ai: mark('available'),
    },
  ];
  const entry = (over: Partial<WorkActivityEntry>): WorkActivityEntry => ({
    id: 'a-1',
    kind: 'audit',
    action: 'work_item.updated',
    actorId: 'u-mat',
    summary: 'Updated the work',
    occurredAt: '2026-11-24T09:00:00.000Z',
    via: null,
    viaApp: null,
    ...over,
  });

  it('finds the AI actor of an audited move and of a comment, and no one else', () => {
    expect(aiActorOf(entry({}), members, [])?.userId).toBe('u-mat');
    expect(aiActorOf(entry({ actorId: 'u-sara' }), members, [])).toBeNull();
    expect(aiActorOf(entry({ actorId: null }), members, [])).toBeNull();
    const comment = {
      id: 'c-1',
      workItemId: 'wi-1',
      authorMembershipId: 'm-mat',
      authorUserId: 'u-mat',
      authorName: 'Mat',
      body: 'Draft ready',
      createdAt: '2026-11-24T09:00:00.000Z',
    };
    expect(
      aiActorOf(entry({ kind: 'comment', actorId: 'm-mat' }), members, [comment])?.userId,
    ).toBe('u-mat');
    expect(
      aiActorOf(entry({ kind: 'comment', actorId: 'm-other' }), members, [comment]),
    ).toBeNull();
  });

  it('shows his avatar, name and mark', async () => {
    const { container } = render(
      <ol>
        <li>
          <WorkActivityWho member={members[1] as MemberSummary} /> Updated the work
        </li>
      </ol>,
    );
    const who = screen.getByTestId('activity-ai-actor');
    expect(within(who).getByText('Mat')).toBeTruthy();
    expect(within(who).getByText('AI employee')).toBeTruthy();
    await expectNoAxeViolations(container);
  });
});

describe('60-08: the letters in an AI employee avatar follow the S7 designs', () => {
  it('two letters for a one-word Latin name, first letters otherwise', () => {
    expect(aiInitialsOf('Mat')).toBe('MA');
    expect(aiInitialsOf('Nour')).toBe('NO');
    expect(aiInitialsOf('Mat Writer')).toBe('MW');
    expect(aiInitialsOf('زياد')).toBe('ز');
    expect(aiInitialsOf('  ')).toBe('?');
  });
});
