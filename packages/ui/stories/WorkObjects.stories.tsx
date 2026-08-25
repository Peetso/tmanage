import type { Meta, StoryObj } from '@storybook/react-vite';
import { Avatar, AvatarOverflow } from '../src/components/Avatar.js';
import { Badge } from '../src/components/Badge.js';
import { InlineAlert } from '../src/components/InlineAlert.js';
import { Skeleton } from '../src/components/Skeleton.js';
import { StateCapsule } from '../src/components/StateCapsule.js';
import { StatusDot } from '../src/components/StatusDot.js';

const meta = {
  title: '04 Work Object DNA/Markers',
  component: StateCapsule,
  args: { children: 'In progress', state: 'current' },
} satisfies Meta<typeof StateCapsule>;

export default meta;
type Story = StoryObj<typeof meta>;

const row = { display: 'flex', gap: 'var(--s3)', alignItems: 'center', flexWrap: 'wrap' } as const;

/**
 * Every capsule carries a colour, a shape and a word. Switch the toolbar to high contrast:
 * several of the borders collapse onto one line colour, and the shape is what still tells
 * the states apart.
 */
export const StateCapsules: Story = {
  render: () => (
    <div style={row}>
      <StateCapsule state="future">Not started</StateCapsule>
      <StateCapsule state="current">In progress</StateCapsule>
      <StateCapsule state="blocked">Blocked</StateCapsule>
      <StateCapsule state="waiting">Client review</StateCapsule>
      <StateCapsule state="done">Approved</StateCapsule>
      <StateCapsule state="client">Client visible</StateCapsule>
      <StateCapsule state="archived">Archived</StateCapsule>
      <StateCapsule state="neutral">Triage</StateCapsule>
    </div>
  ),
};

export const StatusDots: Story = {
  render: () => (
    <div style={row}>
      <StatusDot>Idle</StatusDot>
      <StatusDot tone="live">Live</StatusDot>
      <StatusDot tone="success">Delivered</StatusDot>
      <StatusDot tone="warning">At risk</StatusDot>
      <StatusDot tone="danger">Failed</StatusDot>
      <StatusDot tone="client">Client</StatusDot>
    </div>
  ),
};

export const Avatars: Story = {
  render: () => (
    <div style={row}>
      <Avatar name="Nadia Rahman" />
      <Avatar name="Omar Haddad" audience="client" />
      <Avatar name="Ines Costa" size="feature" />
      <AvatarOverflow count={7} label="7 more people" />
    </div>
  ),
};

export const Badges: Story = {
  render: () => (
    <div style={row}>
      <Badge>Draft</Badge>
      <Badge tone="client">Client organisation</Badge>
      <Badge mono>v4 · 8f21c0</Badge>
    </div>
  ),
};

export const Alerts: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s4)', maxWidth: 'var(--reading)' }}>
      <InlineAlert title="Two approvals are waiting">
        Both are on the homepage direction deliverable.
      </InlineAlert>
      <InlineAlert tone="success" title="Version published">
        Version 4 is now the client-visible version.
      </InlineAlert>
      <InlineAlert tone="warning" title="Forecast is later than committed">
        The committed date is 3 September; the forecast is 11 September.
      </InlineAlert>
      <InlineAlert tone="danger" title="Publication blocked">
        A linked object is internal-only. Remove the link or review it explicitly.
      </InlineAlert>
      <InlineAlert tone="client" title="This will reach the client">
        Four people at Atlas will be notified.
      </InlineAlert>
    </div>
  ),
};

export const Loading: Story = {
  render: () => (
    <div aria-busy="true" style={{ display: 'grid', gap: 'var(--s3)', maxWidth: 'var(--reading)' }}>
      <Skeleton width="40%" height="var(--t-heading-card-line)" />
      <Skeleton />
      <Skeleton width="70%" />
      <Skeleton width="55%" />
    </div>
  ),
};
