import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { AiActionsScreen } from '../src/components/screens/AiActionsScreen';
import {
  PendingAiActionsBadge,
  pendingTitle,
} from '../src/components/ai-actions/pending-ai-actions';
import { pendingAiApprovalsKey } from '../src/lib/api/ai-approvals';
import type { AiApprovalView } from '../src/lib/api/ai-approvals';
import { HelpPromptBox } from '../src/components/website/pages/help/HelpArticlePage';
import { AI_RECIPES, AI_RECIPE_ARTICLES } from '../src/content/help/ai-recipes';
import { HELP_ARTICLES } from '../src/content/help/help-articles';
import { HELP_SLUGS } from '../src/content/help/help-slugs';
import { expectNoAxeViolations } from './axe';

function approval(id: string): AiApprovalView {
  return {
    id,
    status: 'pending',
    clientName: 'Claude',
    memberName: 'Maya Hassan',
    memberEmail: 'maya@example.test',
    summary: {
      opId: 'work_items.delete',
      title: 'Delete a work item',
      method: 'DELETE',
      destructive: true,
      notifies: false,
      subject: 'Homepage direction review',
      fields: [],
    },
    expiresAt: '2026-11-18T13:00:00.000Z',
    decidedAt: null,
  };
}

function mount(items: AiApprovalView[]) {
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify({ items }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={query}>
      <AiActionsScreen organizationSlug="northstar" organizationName="Northstar" client={client} />
    </QueryClientProvider>,
  );
}

describe('AI actions (55-15p)', () => {
  it('lists each waiting action with a link to its approve page, and is axe-clean', async () => {
    const { container } = mount([approval('pa-1'), approval('pa-2')]);
    // TESTUX P1 9: each row is titled by the item it acts on, the action's kind under it.
    expect(
      await screen.findAllByRole(
        'heading',
        { name: 'Delete “Homepage direction review”' },
        { timeout: 3000 },
      ),
    ).toHaveLength(2);
    expect(screen.getAllByText('Delete work item')).toHaveLength(2);
    const reviews = screen.getAllByRole('link', { name: 'Review' });
    expect(reviews.map((link) => link.getAttribute('href'))).toEqual([
      '/northstar/ai/approve/pa-1',
      '/northstar/ai/approve/pa-2',
    ]);
    await expectNoAxeViolations(container);
  });

  it('says so when nothing waits', async () => {
    mount([]);
    expect(await screen.findByTestId('tm-ai-actions-empty')).toBeTruthy();
  });

  it('marks the menu entry with the amber Waiting capsule, and nothing when none wait', async () => {
    const query = new QueryClient();
    query.setQueryData(pendingAiApprovalsKey('northstar'), [approval('pa-1'), approval('pa-2')]);
    const { container, rerender } = render(
      <QueryClientProvider client={query}>
        <PendingAiActionsBadge organizationSlug="northstar" />
      </QueryClientProvider>,
    );
    const badge = container.querySelector('.tm-cc-sections__waiting');
    expect(badge?.textContent).toContain('2 waiting');
    expect(badge?.classList.contains('tm-state-capsule--waiting')).toBe(true);
    query.setQueryData(pendingAiApprovalsKey('northstar'), []);
    rerender(
      <QueryClientProvider client={query}>
        <PendingAiActionsBadge organizationSlug="northstar" />
      </QueryClientProvider>,
    );
    expect(container.querySelector('.tm-cc-sections__waiting')).toBeNull();
  });

  it('words the waiting title for one, several and mixed assistants', () => {
    const tOr = (_key: string, english: string) => english;
    expect(pendingTitle(tOr, 1, 'Claude')).toBe(
      '1 action from Claude is waiting for your approval',
    );
    expect(pendingTitle(tOr, 3, null)).toBe(
      '3 actions from your assistant are waiting for your approval',
    );
  });
});

describe('AI recipes as help articles (55-15p)', () => {
  it('ships a hub and 6–8 recipes, each with one request to copy in EN and AR', () => {
    expect(AI_RECIPES.length).toBeGreaterThanOrEqual(6);
    expect(AI_RECIPES.length).toBeLessThanOrEqual(8);
    for (const recipe of AI_RECIPES) {
      for (const language of ['en', 'ar'] as const) {
        const prompts = recipe[language].body.filter((block) => block.kind === 'prompt');
        expect(prompts).toHaveLength(1);
      }
    }
    for (const article of AI_RECIPE_ARTICLES) {
      expect(HELP_ARTICLES).toContain(article);
      expect(HELP_SLUGS).toContain(article.slug);
    }
  });

  it('copies the request with one click', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    render(<HelpPromptBox text="Plan my week." language="en" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('Plan my week.');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });
});
