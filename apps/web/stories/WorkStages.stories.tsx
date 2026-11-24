import type { Meta, StoryObj } from '@storybook/react-vite';
import { DeleteStageDialog } from '../src/components/work/stages/DeleteStageDialog';
import { ProjectStagesScreen } from '../src/components/work/stages/ProjectStagesScreen';
import { StagesSettingsScreen } from '../src/components/work/stages/StagesSettingsScreen';
import { ARABIC_STORY } from './support/arabic';
import { asOwner } from './support/as-owner';
import { stageSetsFixture, stagesWorld } from './support/stage-fixtures';
import { markVrReady, waitForElement, withStillAppRouter } from './support/vr-fixtures';
import { PHONE_VIEWPORT } from '../.storybook/vr-viewport';

/**
 * **Work area v2 — Stages** (W-WEB-5; Figma W7 stages editor `937:99028` EN, `937:99338` AR,
 * phone `937:99538`; W8 project stages `937:100226` and New stage set `937:100415`; W9 a group
 * with no stage `939:100522` and the delete-stage confirm `939:101154`). The Design thinking set
 * of the workspace's three, each group with its stages, rename and voice naming, Add stage and
 * "One Done stage"; the project's own set as its board columns.
 */
const meta = {
  title: 'Work/Stages',
  component: StagesSettingsScreen,
  tags: ['vr'],
  // An owner, as in the Figma: the Control Center menu shows Work setup › Stages, marked.
  decorators: [withStillAppRouter, asOwner],
  args: {
    organizationSlug: 'northstar',
    organizationName: 'Northstar Studio',
    setId: 'set-design',
    client: stagesWorld().client,
  },
} satisfies Meta<typeof StagesSettingsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Settings → Stages, Design thinking open (W7). */
export const Editor: Story = {};

/** The same in real Arabic, mirrored (W7 AR). */
export const EditorArabic: Story = { ...ARABIC_STORY };

/** Phone: one set, with "‹ Stages" back to the list (W7 phone). */
export const Phone: Story = { globals: { viewport: { value: PHONE_VIEWPORT } } };

/** Rename a stage, typed or dictated: the name, then the mic and language (W7 `937:99028`). */
export const RenameStageWithVoice: Story = {
  tags: ['vr', 'vr-play'],
  play: async ({ canvasElement }) => {
    const more = await waitForElement<HTMLButtonElement>(
      canvasElement,
      '.tm-stg-row[data-stage-id="st-ideate"] .tm-stg-more__button',
    );
    more.click();
    const rename = await waitForElement<HTMLButtonElement>(
      canvasElement,
      '.tm-stg-more__menu [role="menuitem"]',
    );
    rename.click();
    await waitForElement(canvasElement, '.tm-stg-row[data-editing] .tm-voice');
    markVrReady();
  },
};

/** The info popover beside "Stages", open under its round icon button (W7 `937:99739`). */
export const InfoPopover: Story = {
  tags: ['vr', 'vr-play'],
  play: async ({ canvasElement }) => {
    const info = await waitForElement<HTMLButtonElement>(
      canvasElement,
      '.tm-stg-info .tm-info-button',
    );
    info.click();
    await waitForElement(document, '.tm-info-popover:not([hidden])');
    markVrReady();
  },
};

/** A group with no stage: work skips it (W9). */
export const EmptyGroup: Story = { args: { client: stagesWorld({ emptyReview: true }).client } };

/** New stage set, Design thinking chosen (W8), as the desktop dialog. */
export const NewSet: Story = { tags: ['vr-fullpage'], args: { startNew: true } };

/** New stage set on phone: a whole page with Create in the header (W8 phone). */
export const NewSetPhone: Story = {
  tags: ['vr-fullpage'],
  args: { startNew: true },
  globals: { viewport: { value: PHONE_VIEWPORT } },
};

const design = stageSetsFixture()[1]!;
const ideate = design.stages.find((stage) => stage.id === 'st-ideate')!;

/** Delete a stage: where its work moves (W9). */
export const DeleteStage: Story = {
  tags: ['vr-fullpage'],
  render: () => (
    <DeleteStageDialog
      stage={ideate}
      stageName={ideate.name}
      targets={design.stages.filter(
        (stage) => stage.stateKey === 'in_progress' && stage !== ideate,
      )}
      targetName={(stage) => stage.name}
      pending={false}
      failure={undefined}
      onConfirm={() => undefined}
      onClose={() => undefined}
    />
  ),
};

/** Project → Stages: its own set and board columns, or the workspace's (W8). */
function renderProjectStages() {
  return (
    <ProjectStagesScreen
      organizationSlug="northstar"
      organizationName="Northstar Studio"
      projectId="proj-1"
      client={stagesWorld().client}
    />
  );
}

export const ProjectStages: Story = { render: renderProjectStages };

/** Project → Stages in real Arabic (W8 AR). */
export const ProjectStagesArabic: Story = { ...ARABIC_STORY, render: renderProjectStages };
