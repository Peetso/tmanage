import type { Meta, StoryObj } from '@storybook/react-vite';
import { HomeBriefingCard } from '../src/components/screens/HomeBriefingCard';
import {
  BRIEFING_EMPTY,
  BRIEFING_LEAD,
  BRIEFING_NOW,
  briefingClient,
} from './support/briefing-fixtures';

/**
 * **Business briefing on Home** (62-A1b; FIGMA-D section 754:43636: owner, lead, empty, phone; AR
 * with `direction: rtl`). The stub answers the briefing read with the fixtures
 * `tests/home-briefing-card.test.tsx` asserts on. Baselines are taken in the batch test phase.
 */
const meta = {
  title: 'Home/Business briefing',
  component: HomeBriefingCard,
  // A [vr] screen since T2 (62-A1b baselines, BATCH-2026-11-19 section 6).
  tags: ['vr'],
  args: { organizationSlug: 'northstar', now: BRIEFING_NOW, client: briefingClient() },
} satisfies Meta<typeof HomeBriefingCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The owner: the whole company, eight groups, money included. */
export const Owner: Story = {};

/** A project lead without finance access: their projects and people, no money group. */
export const Lead: Story = { args: { client: briefingClient({ briefing: BRIEFING_LEAD }) } };

/** Nothing open after the last check. */
export const Empty: Story = { args: { client: briefingClient({ briefing: BRIEFING_EMPTY }) } };

/** The check failed: the card says so and offers a retry. */
export const Failed: Story = { args: { client: briefingClient({ briefing: 'fail' }) } };

/** Phone: each group shows its header and first line and opens on tap. */
export const Phone: Story = { globals: { viewport: { value: 'phone' } } };
