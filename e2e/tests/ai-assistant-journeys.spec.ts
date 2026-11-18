import { expect } from '@playwright/test';
import { API_URL } from '../setup/stack.js';
import { LANGS, expectLanguage, inLang, seedWorld, test, word } from '../setup/journey-kit.js';

/**
 * TESTE2E (pass 2026-11-18) — MCPEASE: connecting an AI assistant in three steps, and the actions
 * it leaves waiting, in English and in Arabic.
 *
 * - **AI-01** — on Settings › AI assistant an owner picks Claude (step 1), gets the one line to
 *   paste, the `/mcp` address, with Claude's own path (step 2), and step 3 waits for the
 *   assistant. The assistant then connects for real — a personal access token on the hosted MCP
 *   endpoint — and asks, on the token's REST channel, to delete a work item: a confirm-class
 *   action, frozen for approval, never run. Reloaded, step 3 reads Connected, the waiting card counts one action and
 *   its Review link opens that action, and the settings rail's "AI actions" carries "1 waiting".
 *   Declined, the card and the badge are gone, and the work item is still there.
 *
 * The twin workspace, so Northstar's AI state stays as the other journeys expect it.
 */

interface World {
  readonly twin: { readonly workItemId: string; readonly owner: { readonly id: string } };
}

const TWIN = 'northstar-studios';
const world = (): World => seedWorld<World>();

/** A number as either digit set the Arabic catalogue may print. */
function countPattern(text: string, count: number): RegExp {
  const arabic = String(count).replace(/\d/gu, (d) => String.fromCharCode(0x0660 + Number(d)));
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(escaped.replace('\\{count\\}', `(?:${count}|${arabic})`), 'u');
}

for (const lang of LANGS) {
  test(`AI-01 [${lang}]: three steps connect an assistant, and its waiting action is counted and declined`, async ({
    request,
    signIn,
  }) => {
    test.setTimeout(240_000);
    const owner = await signIn(world().twin.owner.id, { member: { org: TWIN, lang } });
    const { page, context, headers } = owner;
    const base = `${API_URL}/v1/organizations/${TWIN}`;

    await page.goto(inLang(`/${TWIN}/settings/ai-assistant`, lang));
    await expectLanguage(page, lang);
    await expect(
      page.getByRole('heading', { name: word(lang, 'AiAssistantScreen.stepPick') }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: word(lang, 'AiAssistantScreen.stepCopy') }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: word(lang, 'AiAssistantScreen.stepCheck') }),
    ).toBeVisible();

    // Step 1 → 2: Claude's path, and the one line to paste.
    const claude = page
      .getByRole('group', { name: word(lang, 'AiAssistantScreen.chooseAssistant') })
      .getByRole('button', { name: 'Claude', exact: true });
    await claude.click();
    await expect(claude).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('tm-ai-path')).toHaveText(
      word(lang, 'AiAssistantScreen.pathClaude'),
    );
    await expect(page.getByTestId('tm-ai-line')).toHaveText(/^https?:\/\/[^\s]+\/mcp$/u);
    await expect(page.getByTestId('tm-ai-pending')).toHaveCount(0);

    // The assistant connects: a token, used on the hosted MCP endpoint.
    const created = await context.request.post(`${base}/me/personal-access-tokens`, {
      headers,
      data: {
        name: `Claude ${lang} ${Date.now()}`,
        expiresInDays: 30,
        scopes: ['tmanage:read', 'tmanage:write', 'tmanage:manage'],
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { token } = (await created.json()) as { token: string };
    // It connects on the hosted MCP endpoint: the tool list is its first call.
    const listed = await request.post(`${API_URL}/mcp`, {
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(listed.status(), await listed.text()).toBe(200);
    expect(await listed.text()).toContain('tmanage_run_action');

    // It asks to delete a work item — confirm-class. On the token's REST channel the request is
    // frozen for approval (`BoundTokenConfirmInterceptor`): 202 with the approve link, nothing run.
    // (The MCP runtime refuses confirm-class actions outright today; see TESTE2E-REPORT.md.)
    const asked = await request.delete(`${base}/work-items/${world().twin.workItemId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(asked.status(), await asked.text()).toBe(202);
    const frozen = (await asked.json()) as { status: string; approval_url: string };
    expect(frozen.status).toBe('approval_required');
    expect(frozen.approval_url).toContain(`/${TWIN}/ai/approve/`);

    // Step 3 and the waiting card, as the reloaded screen reads them.
    await page.reload();
    await expectLanguage(page, lang);
    await expect(page.getByTestId('tm-ai-status')).toContainText(
      word(lang, 'AiAssistantScreen.statusConnected'),
    );
    const pending = page.getByTestId('tm-ai-pending');
    await expect(pending).toBeVisible();
    await expect(pending).toContainText(word(lang, 'AiAssistantScreen.pendingBody'));
    const review = pending.getByRole('link', { name: word(lang, 'AiAssistantScreen.review') });
    await expect(review).toHaveAttribute('href', new RegExp(`/${TWIN}/ai/approve/[0-9a-f-]+`, 'u'));
    const actionId = ((await review.getAttribute('href')) as string).split('/').pop() as string;

    const rail = page.getByRole('link', {
      name: new RegExp(word(lang, 'AiAssistantScreen.navAiActions'), 'u'),
    });
    await expect(rail).toContainText(countPattern(word(lang, 'AiAssistantScreen.navWaiting'), 1));

    // Declined: nothing ran, and nothing waits.
    const declined = await context.request.post(`${base}/ai/approvals/${actionId}/decline`, {
      headers,
    });
    expect(declined.ok(), await declined.text()).toBe(true);
    await page.reload();
    await expect(page.getByTestId('tm-ai-status')).toContainText(
      word(lang, 'AiAssistantScreen.statusConnected'),
    );
    await expect(page.getByTestId('tm-ai-pending')).toHaveCount(0);
    await expect(rail).not.toContainText(
      countPattern(word(lang, 'AiAssistantScreen.navWaiting'), 1),
    );
    const item = await context.request.get(`${base}/work-items/${world().twin.workItemId}`);
    expect(item.status()).toBe(200);
    await owner.close();
  });
}
