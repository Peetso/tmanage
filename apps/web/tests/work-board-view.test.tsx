import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { columnOf, matchesDue, WorkBoardView } from '../src/components/screens/WorkBoardView';
import type { WorkItemSummary } from '../src/lib/api/work-items';
import type { MemberSummary } from '../src/lib/api/members';
import { translate, type MessageKey } from '../src/lib/i18n/t';

/**
 * A6 — the board (Figma fq7-board-view): four columns from the work states with count pills,
 * the "Client review" chip, and the Owner filter narrowing the cards in place.
 */
const L = (key: string) => translate('en-US', key as MessageKey);

function item(id: string, overrides: Partial<WorkItemSummary>): WorkItemSummary {
  return {
    id,
    projectId: 'proj-1',
    type: 'task',
    title: id,
    description: null,
    state: 'backlog',
    ownerUserId: null,
    audience: 'internal',
    startAt: null,
    dueAt: null,
    completedAt: null,
    version: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

const MEMBERS: readonly MemberSummary[] = [
  { userId: 'u-mona', displayName: 'Mona Saleh', role: 'member', status: 'active' },
  { userId: 'u-karim', displayName: 'Karim Adel', role: 'member', status: 'active' },
];

const ITEMS = [
  item('Footer links', { state: 'ready', ownerUserId: 'u-karim', dueAt: '2026-11-03T12:00:00Z' }),
  item('Contact form copy', { state: 'backlog', ownerUserId: 'u-mona' }),
  item('Homepage hero copy', { state: 'in_progress', ownerUserId: 'u-mona' }),
  item('Navigation redesign', { state: 'blocked', ownerUserId: 'u-karim' }),
  item('Pricing page layout', {
    state: 'internal_review',
    audience: 'client_visible',
    ownerUserId: 'u-karim',
  }),
  item('Brand colour audit', {
    state: 'done',
    ownerUserId: 'u-mona',
    completedAt: '2026-10-18T10:00:00Z',
  }),
  item('Old archive', { state: 'archived' }),
];

function renderBoard() {
  render(
    <WorkBoardView
      organizationSlug="northstar"
      items={ITEMS}
      members={MEMBERS}
      membersPending={false}
      now={new Date(2026, 9, 23, 9)}
    />,
  );
}

function column(key: string) {
  return screen.getByRole('region', { name: new RegExp(`^${L(key)}`) });
}

describe('A6 board view', () => {
  it('puts each item in the column its state belongs to, with counts', () => {
    renderBoard();
    const todo = column('WorkBoard.todo');
    expect(within(todo).getAllByRole('listitem')).toHaveLength(2);
    expect(within(todo).getByText('2')).toBeInTheDocument();
    expect(within(column('WorkBoard.inProgress')).getAllByRole('listitem')).toHaveLength(2);
    const review = column('WorkBoard.inReview');
    expect(within(review).getByText(L('WorkBoard.clientReview'))).toBeInTheDocument();
    expect(within(column('WorkBoard.done')).getByRole('link')).toHaveTextContent(
      'Brand colour audit',
    );
    expect(screen.queryByText('Old archive')).toBeNull();
    expect(columnOf('archived')).toBeNull();
  });

  it('filters the cards by owner', async () => {
    renderBoard();
    await userEvent.selectOptions(screen.getByLabelText(L('WorkBoard.ownerFilter')), 'u-mona');
    expect(screen.getByText('Homepage hero copy')).toBeInTheDocument();
    expect(screen.queryByText('Footer links')).toBeNull();
    expect(within(column('WorkBoard.inReview')).queryAllByRole('listitem')).toHaveLength(0);
  });

  it('reads the Due filter against today', () => {
    const due = item('x', { dueAt: '2026-10-28T12:00:00Z' });
    expect(matchesDue(due, 'month', '2026-10-23')).toBe(true);
    expect(matchesDue(due, 'week', '2026-10-23')).toBe(true);
    expect(matchesDue(due, 'overdue', '2026-10-23')).toBe(false);
    expect(matchesDue(item('y', {}), 'month', '2026-10-23')).toBe(false);
  });
});
