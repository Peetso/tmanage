import { describe, expect, it } from 'vitest';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { createTenantContext, type TenantContext } from '../../common/database/tenant-context.js';
import { COMMAND_REGISTRY } from '../search/command-registry.js';
import type { AiCallResult, AiClient, AiRequest, AiUserBlock } from './ai-client.js';
import { messagesBody } from './ai-client.js';
import type { AiBudgetResult, OpenTaskInput } from './ai-budget.service.js';
import { META_TOOL_NAMES } from './ai-chat-tools.js';
import type { AiReplay, AiResponseBlock, AiStopReason } from './ai-response.js';
import { AI_TIER_SPECS, type AiTier } from './ai-tiers.js';
import {
  CopilotChatService,
  DOCUMENT_PAGE_TOKENS,
  bytesAsTokens,
  parseChatBody,
  type ChatTurnInput,
} from './copilot-chat.service.js';
import type { ScanSourceResult } from './knowledge/file-scan-source.js';
import { FILE_READ_OP, RECORD_FILE_SUMMARY_TOOL, SCAN_MAX_PAGES } from './packs/files.js';

/**
 * 62-25 (plan 62 §9 row: "cited answer; second ask of the same file is cheaper; no silent scan
 * read") — questions about one file against a scripted model (the fake model: every reply below
 * is written by the test), an in-memory budget, a fake file route and a fake summary cache. No key,
 * no network, no database.
 */

const SCOPE = { orgSlug: 'northstar', commands: COMMAND_REGISTRY };
const FILE_ID = '0190a000-0000-7000-8000-0000000000f1';
const TEXT_ID = '0190a000-0000-7000-8000-0000000000a1';

function memberContext(): TenantContext {
  return createTenantContext({
    organizationId: uuidv7(),
    userId: uuidv7(),
    membershipId: uuidv7(),
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: 'v1',
    correlationId: uuidv7(),
  });
}

const USAGE = {
  inputTokens: 100,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 20,
};

function reply(stopReason: AiStopReason, content: AiResponseBlock[]): AiCallResult {
  return {
    id: `msg_${uuidv7()}`,
    model: 'scripted',
    stopReason,
    content,
    replay: content as unknown as AiReplay,
    usage: USAGE,
    cost: { microUsd: 50, model: 'claude-haiku-5-5' } as never,
    latencyMs: 5,
  };
}
const text = (value: string) => reply('end_turn', [{ type: 'text', text: value }]);
const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
  reply('tool_use', [{ type: 'tool_use', id, name, input }]);

interface FileState {
  status: 'ready' | 'scan_only' | 'pending' | 'unsupported';
  body: string | null;
  audience?: 'internal' | 'client_visible';
}

function setup(script: AiCallResult[], file: FileState, options: { visible?: boolean } = {}) {
  const requests: AiRequest[] = [];
  const client: AiClient = {
    async call(request) {
      requests.push(request);
      const next = script.shift();
      if (next === undefined) throw new Error('the script ran out');
      return next;
    },
  };
  const opened: OpenTaskInput[] = [];
  const tasks = new Map<string, AiTier>();
  const ok = <T>(value: T): AiBudgetResult<T> => ({ ok: true, value });
  const budget = {
    async openTask(_c: TenantContext, input: OpenTaskInput) {
      opened.push(input);
      const taskId = uuidv7();
      tasks.set(taskId, input.tier);
      const spec = AI_TIER_SPECS[input.tier];
      return ok({
        taskId,
        tier: input.tier,
        model: spec.model,
        pool: 'customers' as const,
        payer: spec.payer,
        ceilingCredits: spec.ceilingCredits,
      });
    },
    async reserveCall(_c: TenantContext, input: { taskId: string }) {
      return ok({
        callId: uuidv7(),
        model: AI_TIER_SPECS[tasks.get(input.taskId) ?? 'low'].model,
        holdMicroUsd: 1000,
        holdExpiresAt: new Date(),
      });
    },
    markSent: async () => ok(null),
    settleCall: async () => ok({ costMicroUsd: 50, overSettled: false }),
    releaseCall: async () => ok(null),
    finishTask: async (_c: TenantContext, _t: string, outcome: string) =>
      ok({ chargedCredits: outcome === 'completed' ? 1 : 0, costMicroUsd: 50 }),
  };
  // The summary cache: keyed by (text row, audience), as the route keys it by (hash, audience).
  const summaries = new Map<string, string>();
  const recorded: { textId: string; audience: string; summary: string; model: string }[] = [];
  const fileRuns: Record<string, unknown>[] = [];
  const scans: { fileAssetId: string; maxPages: number }[] = [];
  let scanResult: ScanSourceResult = { ok: true, data: 'JVBERi0=', pages: 3 };
  const audience = file.audience ?? 'internal';
  const service = new CopilotChatService({
    standing: async () => ({
      onTestList: true,
      copilotFlag: true,
      writeScope: 'read',
      poolClass: 'customers',
      runAtOnce: false,
    }),
    allowance: async () => ({ workspaceCredits: 1000, memberCredits: 1000 }),
    budget: budget as never,
    clientFor: () => client,
    surface: () => ({
      async runTool(name, args) {
        const actionId = name === META_TOOL_NAMES.run ? args['action_id'] : null;
        if (actionId !== FILE_READ_OP) return { data: { passages: [] } };
        fileRuns.push(args['args'] as Record<string, unknown>);
        if (options.visible === false) return { isError: true, data: { status: 404 } };
        const summary = summaries.get(`${TEXT_ID}|${audience}`) ?? null;
        const ready = file.status === 'ready';
        return {
          data: {
            fileId: FILE_ID,
            fileName: 'Contract.pdf',
            projectId: 'prj_1',
            href: `/files/${FILE_ID}`,
            audience,
            status: file.status,
            reasonCode: file.status === 'scan_only' ? 'pdf_no_text_layer' : null,
            chars: file.body?.length ?? 0,
            pages: ready ? 4 : null,
            truncated: false,
            textId: TEXT_ID,
            summary,
            text: ready && summary === null ? file.body : null,
            textCut: false,
            passages:
              ready && summary !== null
                ? [{ fileId: FILE_ID, pageNo: 2, text: 'Notice: thirty days.' }]
                : [],
          },
        };
      },
    }),
    countTokens: bytesAsTokens,
    fileSummaries: {
      async record(_c, summary) {
        recorded.push({ ...summary });
        summaries.set(`${summary.textId}|${summary.audience}`, summary.summary);
        return true;
      },
    },
    fileScans: {
      async read(_c, fileAssetId, maxPages) {
        scans.push({ fileAssetId, maxPages });
        return scanResult;
      },
    },
  });
  const ask = (
    message: string,
    extra: Partial<ChatTurnInput> = {},
    confirmed: ChatTurnInput['confirmed'] = null,
  ) =>
    service.chat(memberContext(), SCOPE, {
      message,
      confirmed,
      file: { fileId: FILE_ID, readScan: false },
      ...extra,
    });
  const setScan = (result: ScanSourceResult) => {
    scanResult = result;
  };
  return { ask, requests, opened, recorded, fileRuns, scans, setScan, script };
}

function firstUserBlocks(request: AiRequest | undefined): readonly AiUserBlock[] {
  // The loop appends to the same messages array: the opening message is the first one.
  const content = request?.messages[0]?.content;
  return Array.isArray(content) ? (content as readonly AiUserBlock[]) : [];
}

const textOf = (blocks: readonly AiUserBlock[]) =>
  blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');

async function status(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'ok';
  } catch (error) {
    if (error instanceof ApiError)
      return `${String(error.status)} ${error.auditCode ?? error.code}`;
    throw error;
  }
}

const CONTRACT = 'The notice period is thirty days. Either party may end the contract in writing.';

describe('a question about one file (62-25)', () => {
  it('answers with a cited link at Low, from the file read as the member, with no router call', async () => {
    const env = setup(
      [
        toolUse('s1', RECORD_FILE_SUMMARY_TOOL, {
          summary: 'A services contract; notice period thirty days.',
        }),
        text(`The notice period is thirty days ([Contract.pdf](/files/${FILE_ID})).`),
      ],
      { status: 'ready', body: CONTRACT },
    );
    const view = await env.ask('What is the notice period?');
    expect(view).toMatchObject({ state: 'answer', domain: 'files', tier: 'low' });
    // The citation survives: the file's id came back from the file route this turn.
    expect(view.answer).toContain(`(/files/${FILE_ID})`);
    expect(env.opened).toEqual([
      expect.objectContaining({ tier: 'low', activity: 'file_analysis' }),
    ]);
    expect(env.fileRuns).toEqual([{ fileAssetId: FILE_ID, q: 'What is the notice period?' }]);
    // The first call already carries the file, marked untrusted, before the question.
    const blocks = firstUserBlocks(env.requests[0]);
    expect(textOf(blocks)).toContain('<untrusted_content source="knowledge.files.get">');
    expect(textOf(blocks)).toContain(`[1] file | Contract.pdf | /files/${FILE_ID} | 4 pages`);
    expect(textOf(blocks)).toContain(CONTRACT);
    expect(env.requests[0]?.tools.map((tool) => tool.name)).toContain(RECORD_FILE_SUMMARY_TOOL);
    // The summary is kept against the text row and audience the route gave, not the model's say.
    expect(env.recorded).toEqual([
      {
        textId: TEXT_ID,
        audience: 'internal',
        summary: 'A services contract; notice period thirty days.',
        model: AI_TIER_SPECS.low.model,
      },
    ]);
    expect(view.toolCalls).toEqual([
      { opId: FILE_READ_OP, outcome: 'ok' },
      { opId: null, outcome: 'ok' },
    ]);
  });

  it('drops a link to a file the turn never read', async () => {
    const other = '0190a000-0000-7000-8000-0000000000f9';
    const env = setup([text(`See [the brief](/files/${other}).`)], {
      status: 'ready',
      body: CONTRACT,
    });
    const view = await env.ask('Is there a brief?');
    expect(view.answer).toBe('See the brief.');
  });

  it('a second ask of the same file is cheaper: Low with the saved summary, not the whole text', async () => {
    const long = `${'Clause. '.repeat(4_000)}${CONTRACT}`; // ~32,000 chars: Medium on the first ask
    const env = setup(
      [
        toolUse('s1', RECORD_FILE_SUMMARY_TOOL, {
          summary: 'A long contract; notice thirty days.',
        }),
        text('Thirty days.'),
        text('Thirty days, in writing.'),
      ],
      { status: 'ready', body: long },
    );
    const first = await env.ask('What is the notice period?');
    const firstPrompt = await bytesAsTokens(env.requests[0]!);
    const second = await env.ask('How must notice be given?');
    const secondRequest = env.requests[2]!;
    expect(first).toMatchObject({ state: 'answer', tier: 'medium' });
    expect(second).toMatchObject({ state: 'answer', tier: 'low' });
    expect(env.opened.map((o) => o.tier)).toEqual(['medium', 'low']);
    const secondText = textOf(firstUserBlocks(secondRequest));
    expect(secondText).toContain('Saved summary:');
    expect(secondText).toContain('Passage (page 2):');
    expect(secondText).not.toContain('Clause. Clause.');
    // No summary is offered again once one is saved.
    expect(secondRequest.tools.map((tool) => tool.name)).not.toContain(RECORD_FILE_SUMMARY_TOOL);
    // The whole text (about 32,000 bytes) is not sent again.
    expect(await bytesAsTokens(secondRequest)).toBeLessThan(firstPrompt - 25_000);
  });

  it('never reads a scan silently: an estimate that offers the scan, no task, no model call', async () => {
    const env = setup([], { status: 'scan_only', body: null });
    const view = await env.ask('What does this scan say?');
    expect(view).toMatchObject({
      state: 'estimate',
      domain: 'files',
      tier: 'medium_high',
      ceilingCredits: AI_TIER_SPECS.medium_high.ceilingCredits,
      file: { fileId: FILE_ID, readScan: true, reasonCode: null },
      chargedCredits: 0,
    });
    expect(env.opened).toEqual([]);
    expect(env.requests).toEqual([]);
    expect(env.scans).toEqual([]);
    // Accepting the tier without the scan is still not a scan read.
    const tierOnly = await env.ask(
      'What does this scan say?',
      {},
      {
        tier: 'medium_high',
        domain: 'files',
      },
    );
    expect(tierOnly.state).toBe('estimate');
    expect(env.scans).toEqual([]);
    expect(env.requests).toEqual([]);
  });

  it('reads the scan only on the turn that accepted it: the PDF goes first, at Sonnet', async () => {
    const env = setup(
      [
        toolUse('s1', RECORD_FILE_SUMMARY_TOOL, { summary: 'A scanned lease.' }),
        text(`It is a lease ([Contract.pdf](/files/${FILE_ID})).`),
      ],
      { status: 'scan_only', body: null },
    );
    const view = await env.ask(
      'What does this scan say?',
      { file: { fileId: FILE_ID, readScan: true } },
      { tier: 'medium_high', domain: 'files' },
    );
    expect(view).toMatchObject({ state: 'answer', tier: 'medium_high' });
    expect(env.scans).toEqual([{ fileAssetId: FILE_ID, maxPages: SCAN_MAX_PAGES }]);
    const blocks = firstUserBlocks(env.requests[0]);
    expect(blocks[0]).toEqual({
      type: 'document',
      mediaType: 'application/pdf',
      data: 'JVBERi0=',
      pages: 3,
    });
    expect(env.requests[0]?.model).toBe(AI_TIER_SPECS.medium_high.model);
    expect(env.recorded.map((r) => r.summary)).toEqual(['A scanned lease.']);
    // The scan is held at its pages, not its base64 bytes.
    expect(await bytesAsTokens(env.requests[0]!)).toBeGreaterThanOrEqual(3 * DOCUMENT_PAGE_TOKENS);
  });

  it('a scan that cannot be read stops before any task opens, and says why', async () => {
    const env = setup([], { status: 'scan_only', body: null });
    env.setScan({ ok: false, code: 'too_many_pages' });
    const view = await env.ask(
      'What does this scan say?',
      { file: { fileId: FILE_ID, readScan: true } },
      { tier: 'medium_high', domain: 'files' },
    );
    expect(view).toMatchObject({
      state: 'stopped',
      stop: 'scan_unavailable',
      file: { fileId: FILE_ID, readScan: false, reasonCode: 'too_many_pages' },
      chargedCredits: 0,
    });
    expect(env.opened).toEqual([]);
    expect(env.requests).toEqual([]);
  });

  it('a long text asks first (the tier stop); the accepted estimate answers at that tier', async () => {
    const huge = 'Term. '.repeat(15_000); // 90,000 chars: Medium-High
    const env = setup([text('It is about terms.')], { status: 'ready', body: huge });
    const estimate = await env.ask('Summarise this');
    expect(estimate).toMatchObject({
      state: 'estimate',
      tier: 'medium_high',
      file: { fileId: FILE_ID, readScan: false },
    });
    expect(env.opened).toEqual([]);
    const answered = await env.ask('Summarise this', {}, { tier: 'medium_high', domain: 'files' });
    expect(answered).toMatchObject({ state: 'answer', tier: 'medium_high' });
  });

  it('a file whose text is not ready is answered at Low without guessing its content', async () => {
    const env = setup([text('The file is still being read.')], { status: 'pending', body: null });
    const view = await env.ask('What is in it?');
    expect(view).toMatchObject({ state: 'answer', tier: 'low' });
    expect(textOf(firstUserBlocks(env.requests[0]))).toContain('Its text is not ready yet');
    expect(env.requests[0]?.tools.map((t) => t.name)).not.toContain(RECORD_FILE_SUMMARY_TOOL);
  });

  it('a file the member cannot open is 404 before any task', async () => {
    const env = setup([], { status: 'ready', body: CONTRACT }, { visible: false });
    expect(await status(env.ask('What is the notice period?'))).toBe(
      '404 copilot.chat:file_not_visible',
    );
    expect(env.opened).toEqual([]);
    expect(env.requests).toEqual([]);
  });
});

describe('the file question body (62-25)', () => {
  it('takes a file id and the scan opt-in only with an accepted estimate in the files domain', () => {
    expect(parseChatBody({ message: 'hi', file: { fileId: FILE_ID } })).toMatchObject({
      file: { fileId: FILE_ID, readScan: false },
      confirmed: null,
    });
    expect(
      parseChatBody({
        message: 'hi',
        file: { fileId: FILE_ID, readScan: true },
        confirmed: { tier: 'medium_high', domain: 'files' },
      }),
    ).toMatchObject({ file: { readScan: true }, confirmed: { tier: 'medium_high' } });
    const refused = (body: Record<string, unknown>) => {
      try {
        parseChatBody(body);
        return 'ok';
      } catch (error) {
        return error instanceof ApiError ? error.status : 'other';
      }
    };
    expect(refused({ message: 'hi', file: { fileId: FILE_ID, readScan: true } })).toBe(400);
    expect(refused({ message: 'hi', file: { fileId: '../x' } })).toBe(400);
    expect(refused({ message: 'hi', file: { fileId: FILE_ID, readScan: 'yes' } })).toBe(400);
    expect(refused({ message: 'hi', help: true, file: { fileId: FILE_ID } })).toBe(400);
    expect(
      refused({
        message: 'hi',
        file: { fileId: FILE_ID },
        confirmed: { tier: 'medium_high', domain: 'billing' },
      }),
    ).toBe(400);
  });
});

describe('the document block (62-25)', () => {
  it('goes to the API as a base64 PDF source, without our page count', () => {
    const body = messagesBody({
      model: 'claude-sonnet-5-5',
      maxTokens: 100,
      effort: 'medium',
      system: [],
      tools: [],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', mediaType: 'application/pdf', data: 'JVBERi0=', pages: 2 },
            { type: 'text', text: 'What is it?' },
          ],
        },
      ],
    });
    expect((body['messages'] as { content: unknown }[])[0]?.content).toEqual([
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
      },
      { type: 'text', text: 'What is it?' },
    ]);
  });
});
