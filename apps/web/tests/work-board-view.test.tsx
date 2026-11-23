import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  columnOf,
  dragPath,
  dropTarget,
  WorkBoardView,
} from '../src/components/screens/WorkBoardView';
import type { ApiClient } from '../src/lib/api/client';
import { parseStateParam, workListQuery } from '../src/components/screens/WorkListScreen';
import { NO_FILTERS } from '../src/components/work/list/work-list-model';
import type { WorkItemSummary } from '../src/lib/api/work-items';
import { translate, type MessageKey } from '../src/lib/i18n/t';

/**
 * A6 — the board: without a project stage set, four columns from the stage groups (Figma WV2-10)
 * with count pills. Filters now live in the Works list filter bar (work-list-model.test.ts).
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
  render(<WorkBoardView organizationSlug="northstar" nameOf={(id) => id} items={ITEMS} />);
}

function column(key: string) {
  return screen.getByRole('region', { name: new RegExp(`^${L(key)}`) });
}

describe('A6 board view', () => {
  it('puts each item in the column its state belongs to, with counts', () => {
    renderBoard();
    const todo = column('WorkListScreen.groupNotStarted');
    expect(within(todo).getAllByRole('listitem')).toHaveLength(2);
    expect(within(todo).getByText('2')).toBeInTheDocument();
    expect(within(column('WorkListScreen.groupInProgress')).getAllByRole('listitem')).toHaveLength(
      2,
    );
    expect(within(column('WorkListScreen.groupInReview')).getAllByRole('listitem')).toHaveLength(1);
    expect(within(column('WorkListScreen.groupDone')).getByRole('link')).toHaveTextContent(
      'Brand colour audit',
    );
    expect(screen.queryByText('Old archive')).toBeNull();
    expect(columnOf('archived')).toBeNull();
  });

  it('QA-FIX-R L3: a card title takes its direction from its own text, not the page', () => {
    renderBoard();
    const title = within(column('WorkListScreen.groupDone')).getByRole('link');
    expect(title).toHaveAttribute('dir', 'auto');
  });
});

describe('board drag and drop (WK-03, 2026-10-31 live test)', () => {
  it('finds the steps a drop makes, and refuses the ones that need a reason', () => {
    // FIX4 item 7: starting straight from the backlog is one step (one request, one entry).
    expect(dragPath('backlog', 'in_progress', false)).toEqual(['in_progress']);
    expect(dragPath('in_progress', 'backlog', false)).toEqual(['backlog']);
    expect(dragPath('in_progress', 'done', true)).toEqual(['internal_review', 'done']);
    expect(dragPath('in_progress', 'done', false)).toBeNull();
    expect(dragPath('blocked', 'internal_review', true)).toBeNull();
    expect(dragPath('done', 'ready', true)).toBeNull();
    expect(dropTarget('ready', 'todo')).toBeNull();
    expect(dropTarget('backlog', 'in_review')).toBe('internal_review');
  });

  it('sends a card dropped on another column as its transitions, then re-reads', async () => {
    const request = vi.fn(async ({ body }: { body: { version: number; to: string } }) => ({
      data: item('Drag me', {
        state: body.to as WorkItemSummary['state'],
        version: body.version + 1,
      }),
    }));
    const onMoved = vi.fn();
    render(
      <WorkBoardView
        organizationSlug="northstar"
        nameOf={(id) => id}
        items={[item('Drag me', { state: 'backlog' })]}
        api={{ request } as unknown as ApiClient}
        onMoved={onMoved}
      />,
    );
    const card = screen.getByRole('link', { name: 'Drag me' }).closest('li') as HTMLElement;
    const target = screen
      .getByRole('heading', { name: new RegExp(L('WorkListScreen.groupInProgress')) })
      .closest('section') as HTMLElement;
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? '',
      effectAllowed: 'move',
      dropEffect: 'move',
    };
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    await waitFor(() => expect(onMoved).toHaveBeenCalled());
    expect(request.mock.calls.map(([call]) => call.body.to)).toEqual(['in_progress']);
  });

  it('FIX4 item 7: the Move menu puts a card back in the backlog, and To do makes it ready', async () => {
    const request = vi.fn(async ({ body }: { body: { version: number; to: string } }) => ({
      data: item('Hero', { state: body.to as WorkItemSummary['state'], version: body.version + 1 }),
    }));
    const onMoved = vi.fn();
    const { rerender } = render(
      <WorkBoardView
        organizationSlug="northstar"
        nameOf={(id) => id}
        items={[item('Hero', { state: 'in_progress' })]}
        api={{ request } as unknown as ApiClient}
        onMoved={onMoved}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Move Hero/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Backlog' }));
    await waitFor(() => expect(onMoved).toHaveBeenCalledTimes(1));
    expect(request.mock.calls.map(([call]) => call.body.to)).toEqual(['backlog']);

    rerender(
      <WorkBoardView
        organizationSlug="northstar"
        nameOf={(id) => id}
        items={[item('Hero', { state: 'backlog', version: 2 })]}
        api={{ request } as unknown as ApiClient}
        onMoved={onMoved}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Move Hero/ }));
    expect(screen.getByRole('button', { name: /Backlog/ })).toBeDisabled();
    await userEvent.click(
      screen.getByRole('button', { name: L('WorkListScreen.groupNotStarted') }),
    );
    await waitFor(() => expect(onMoved).toHaveBeenCalledTimes(2));
    expect(request.mock.calls.map(([call]) => call.body.to)).toEqual(['backlog', 'ready']);
  });
});

describe('work list address (2026-10-31 live test)', () => {
  it('keeps the view and the filters in the query string', () => {
    expect(workListQuery({ view: 'list', filters: NO_FILTERS })).toBe('');
    expect(
      workListQuery({
        view: 'board',
        filters: { ...NO_FILTERS, projectId: 'p1', states: ['ready'] },
      }),
    ).toBe('?project=p1&state=ready&view=board');
    expect(parseStateParam('ready,nonsense,done')).toEqual(['ready', 'done']);
    expect(parseStateParam(null)).toEqual([]);
  });
});
