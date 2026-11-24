import type { Meta, StoryObj } from '@storybook/react-vite';
import { PHONE_VIEWPORT } from '../.storybook/vr-viewport';
import { MentionPicker, type MentionOption } from '../src/components/chat/MentionPicker';
import { WorkItemDetailScreen } from '../src/components/screens/WorkItemDetailScreen';
import { useA6T } from '../src/components/work/DueDatePicker';
import type { OwnerCandidate } from '../src/components/work/OwnerPickerDialog';
import { PeoplePickerDialog } from '../src/components/work/WorkPeopleBlock';
import type { AiMemberMark } from '../src/lib/api/members';
import { useTOr } from '../src/lib/i18n/use-t-or';
import { ARABIC_STORY } from './support/arabic';
import { WORK_NOW, workClient } from './support/work-fixtures';

/**
 * **AI employees in Work** (plan 60 slice 60-08; design `ai-employees-figma/AI-S7a…S7d`). Peter
 * Kamal gives "Design the landing page" to Mat, an AI employee:
 *
 * - S7a, the Doers picker: People, then "AI employees" — Mat and Nour can be chosen, Hana is not
 *   connected and Rami is paused, each dimmed with the reason in the muted colour.
 * - S7b, the Supervisor picker: people only, "AI employees can't supervise.", Done stays off
 *   until a person is ticked.
 * - S7b0, the work page: Mat does it, so Peter, who gave it, supervises (the note says so); Mat's
 *   comment and his move in the Activity tab carry the AI mark.
 * - S7b (page): no person supervises, so Supervisor says "Choose a person" in the error colour.
 * - S7d, the @mention picker with its AI employees section.
 *
 * Names are data, so the Arabic stories use the Arabic design's names (زياد for Mat).
 */

interface Cast {
  readonly peter: string;
  readonly sara: string;
  readonly mat: readonly [string, string];
  readonly nour: readonly [string, string];
  readonly hana: readonly [string, string];
  readonly rami: readonly [string, string];
  readonly comment: string;
}

const ENGLISH: Cast = {
  peter: 'Peter Kamal',
  sara: 'Sara Adel',
  mat: ['Mat', 'Social media designer'],
  nour: ['Nour', 'Copywriter'],
  hana: ['Hana', 'Research assistant'],
  rami: ['Rami', 'Video editor'],
  comment: 'First draft of the hero is in Files. Two layouts to choose from.',
};

const ARABIC: Cast = {
  peter: 'بيتر كمال',
  sara: 'سارة عادل',
  mat: ['زياد', 'مصمم سوشيال ميديا'],
  nour: ['نور', 'كاتبة محتوى'],
  hana: ['هنا', 'مساعدة أبحاث'],
  rami: ['رامي', 'مونتير فيديو'],
  comment: 'أول نسخة من الهيرو في الملفات. فيه تصميمين تختار منهم.',
};

function mark(
  jobTitle: string,
  availability: AiMemberMark['availability'] = 'available',
): AiMemberMark {
  return {
    jobTitle,
    status: availability === 'paused' ? 'paused' : 'active',
    connected: availability !== 'not_connected',
    availability,
  };
}

/** Mat and Nour can take work; Hana is not connected; Rami is paused. */
function aiMembers(cast: Cast) {
  const entry = (
    id: string,
    [displayName, jobTitle]: readonly [string, string],
    availability?: AiMemberMark['availability'],
  ) => ({
    userId: `u-${id}`,
    displayName,
    role: 'member',
    kind: 'ai' as const,
    ai: mark(jobTitle, availability),
  });
  return [
    entry('mat', cast.mat),
    entry('nour', cast.nour),
    entry('hana', cast.hana, 'not_connected'),
    entry('rami', cast.rami, 'paused'),
  ];
}

function candidates(cast: Cast, roleLine: (key: string) => string): OwnerCandidate[] {
  return [
    { userId: 'u-peter', displayName: cast.peter, subtitle: roleLine('OwnerPicker.roleLead') },
    { userId: 'u-sara', displayName: cast.sara, subtitle: roleLine('OwnerPicker.roleManager') },
    ...aiMembers(cast).map((member) => ({
      userId: member.userId,
      displayName: member.displayName,
      subtitle: member.ai.jobTitle,
      kind: 'ai' as const,
      ai: member.ai,
    })),
  ];
}

/** The picker as the work page opens it, with the page's own title words. */
function Picker({ cast, row }: { readonly cast: Cast; readonly row: 'doers' | 'supervisors' }) {
  const t = useA6T();
  const list = candidates(cast, (key) => t(key));
  return (
    <PeoplePickerDialog
      title={t(row === 'doers' ? 'WorkPeople.pickDoers' : 'WorkPeople.pickSupervisors')}
      projectName="Website relaunch"
      candidates={list}
      loading={false}
      initial={row === 'doers' ? ['u-mat'] : []}
      showLeadHint={row === 'doers'}
      saving={false}
      onSave={() => undefined}
      onClose={() => undefined}
      {...(row === 'doers'
        ? { ai: 'offer' as const, canAssignAi: true }
        : { ai: 'refuse' as const, requirePerson: true })}
    />
  );
}

function Mentions({ cast }: { readonly cast: Cast }) {
  const tOr = useTOr();
  const options: MentionOption[] = [
    { userId: 'u-peter', displayName: cast.peter, mention: '@u-peter', group: 'others' },
    { userId: 'u-sara', displayName: cast.sara, mention: '@u-sara', group: 'others' },
    {
      userId: 'u-mat',
      displayName: cast.mat[0],
      mention: '@u-mat',
      group: 'ai',
      subtitle: cast.mat[1],
    },
  ];
  return (
    // The picker opens above the comment box it belongs to, so the story leaves it the room.
    <div style={{ paddingBlockStart: '360px' }}>
      <div style={{ position: 'relative', inlineSize: 'min(100%, 420px)', blockSize: '48px' }}>
        <MentionPicker
          id="story-mention"
          options={options}
          activeIndex={2}
          onPick={() => undefined}
          onHover={() => undefined}
          othersHeading={tOr('WorkCommentsPanel.mentionHeading', 'People who can see this task')}
          aiHeading={tOr('AiPickers.aiEmployees', 'AI employees')}
        />
      </div>
    </div>
  );
}

/** The work page's reads with Mat on it: the directory, the project, the people, a comment. */
function aiWorkClient(cast: Cast, supervised: boolean) {
  const ai = aiMembers(cast);
  return workClient({
    override: (path) => {
      switch (path) {
        case '/members':
          return {
            members: [
              { userId: 'u-peter', displayName: cast.peter, role: 'owner', kind: 'human' },
              { userId: 'u-sara', displayName: cast.sara, role: 'manager', kind: 'human' },
              ...ai,
            ],
            nextAfter: null,
          };
        case '/projects/proj-1/members':
          return {
            members: ['u-peter', 'u-sara', ...ai.map((member) => member.userId)].map(
              (userId, index) => ({
                projectMembershipId: `pm-${index}`,
                userId,
                role: 'member',
                createdAt: '',
              }),
            ),
          };
        case '/work-items/wi-1/people':
          return {
            doerUserIds: ['u-mat'],
            supervisorUserIds: supervised ? ['u-peter'] : [],
            watcherUserIds: [],
            viewerUserId: 'u-peter',
            aiDoerUserId: 'u-mat',
            supervisorRequired: !supervised,
            canAssignAi: true,
          };
        case '/work-items/wi-1/comments':
          return {
            comments: [
              {
                id: 'c-1',
                workItemId: 'wi-1',
                authorMembershipId: 'm-mat',
                authorUserId: 'u-mat',
                authorName: cast.mat[0],
                body: cast.comment,
                createdAt: '2026-11-23T08:30:00.000Z',
              },
            ],
          };
        case '/work-items/wi-1/activity':
          return {
            activity: [
              {
                id: 'a-1',
                kind: 'audit',
                action: 'work_item.stage_changed',
                actorId: 'u-mat',
                summary: 'Moved the work to Prototype',
                occurredAt: '2026-11-23T08:00:00.000Z',
                via: null,
                viaApp: null,
              },
            ],
            nextCursor: null,
          };
        default:
          return undefined;
      }
    },
  });
}

const meta = {
  title: 'Work/AI employees (S7)',
  tags: ['vr'],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** The pickers paint in the fixed dialog layer, so their baseline is the whole viewport. */
const DIALOG = ['vr-fullpage'];

const phone = { globals: { viewport: { value: PHONE_VIEWPORT } } } as const;
const phoneArabic = {
  ...ARABIC_STORY,
  globals: { direction: 'rtl', viewport: { value: PHONE_VIEWPORT } },
} as const;

/** S7a — the Doers picker with its AI employees section; Mat is ticked. */
export const DoersPicker: Story = {
  tags: DIALOG,
  render: () => <Picker cast={ENGLISH} row="doers" />,
};
export const DoersPickerArabic: Story = {
  tags: DIALOG,
  ...ARABIC_STORY,
  render: () => <Picker cast={ARABIC} row="doers" />,
};
export const DoersPickerPhone: Story = {
  tags: DIALOG,
  ...phone,
  render: () => <Picker cast={ENGLISH} row="doers" />,
};

/** S7b — the Supervisor picker: people only, and a person must be ticked. */
export const SupervisorPicker: Story = {
  tags: DIALOG,
  render: () => <Picker cast={ENGLISH} row="supervisors" />,
};
export const SupervisorPickerArabic: Story = {
  tags: DIALOG,
  ...ARABIC_STORY,
  render: () => <Picker cast={ARABIC} row="supervisors" />,
};
export const SupervisorPickerPhone: Story = {
  tags: DIALOG,
  ...phone,
  render: () => <Picker cast={ENGLISH} row="supervisors" />,
};
export const SupervisorPickerPhoneArabic: Story = {
  tags: DIALOG,
  ...phoneArabic,
  render: () => <Picker cast={ARABIC} row="supervisors" />,
};

const page = (cast: Cast, supervised: boolean) => (
  <WorkItemDetailScreen
    organizationSlug="northstar"
    organizationName="Northstar Studio"
    workItemId="wi-1"
    now={WORK_NOW}
    client={aiWorkClient(cast, supervised)}
  />
);

/** S7b0 + S7c — Mat does the work, Peter supervises it; Mat's comment carries the AI mark. */
export const WorkPageAiDoer: Story = { render: () => page(ENGLISH, true) };
export const WorkPageAiDoerArabic: Story = { ...ARABIC_STORY, render: () => page(ARABIC, true) };
export const WorkPageAiDoerPhone: Story = { ...phone, render: () => page(ENGLISH, true) };

/** S7b — no person supervises Mat's work: "Choose a person". */
export const WorkPageChoosePerson: Story = { render: () => page(ENGLISH, false) };
export const WorkPageChoosePersonArabic: Story = {
  ...ARABIC_STORY,
  render: () => page(ARABIC, false),
};

/** S7d — the @mention picker with its AI employees section. */
export const MentionPickerAi: Story = { render: () => <Mentions cast={ENGLISH} /> };
export const MentionPickerAiArabic: Story = {
  ...ARABIC_STORY,
  render: () => <Mentions cast={ARABIC} />,
};
