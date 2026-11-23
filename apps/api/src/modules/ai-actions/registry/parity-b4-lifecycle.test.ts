import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { OP_SENSITIVITY, findOpById, isNever } from './index.js';
import { AI_SETTINGS_BOUNDS, lifecycleDetails, lifecycleOps } from './parity-b4-lifecycle.js';
import { allDetailsById } from '../../mcp/tool-catalog.js';
import { changeGateFor } from '../../copilot/ai-preview.js';
import {
  AI_MEMBER_SHARE_MAX_PERCENT,
  AI_MEMBER_SHARE_MIN_PERCENT,
  AI_SETTINGS_MEMBERS_PER_PATCH,
} from '../../copilot/ai-settings.rules.js';
import {
  AI_CONVERSATION_RETENTION_MAX_DAYS,
  AI_CONVERSATION_RETENTION_MIN_DAYS,
} from '../../copilot/ai-conversations.service.js';

/**
 * Fix lane C (live AI test 2026-11-23, §5 G1-G7): what a member can do by hand the AI can do,
 * removing what members made included. Every new change is confirm-class (a card or an approval
 * link), every removal is `destructive`, and every detail is strict and accepts its own examples.
 */

const ORG = '/v1/organizations/:orgSlug';

describe('fix lane C · lifecycle ops', () => {
  it('each op is registered once, has a detail, is out of NEVER, and every change confirms', () => {
    expect(lifecycleOps.length).toBe(13);
    for (const op of lifecycleOps) {
      expect(findOpById(op.id), op.id).toBe(op);
      expect(allDetailsById.has(op.id), op.id).toBe(true);
      expect(isNever(op.method, op.path), op.id).toBe(false);
      if (op.method === 'GET') {
        expect([op.risk, op.scope], op.id).toEqual(['read', 'read']);
      } else {
        expect(op.risk, op.id).toBe('confirm');
        expect(OP_SENSITIVITY[op.id], op.id).toBeDefined();
        expect(changeGateFor(op, { runAtOnce: true, hasUndo: true })?.card, op.id).toBe(true);
      }
      if (op.method === 'DELETE') expect(OP_SENSITIVITY[op.id], op.id).toBe('destructive');
    }
  });

  it('removals and company settings need manage scope; ordinary edits are writes', () => {
    const scope = (id: string) => findOpById(id)?.scope;
    expect(scope('projects.delete')).toBe('manage');
    expect(scope('people.teams.delete')).toBe('manage');
    expect(scope('client_invoices.delete')).toBe('manage');
    expect(scope('copilot.settings.update')).toBe('manage');
    expect(scope('projects.update')).toBe('write');
    expect(scope('work_item_files.upload_inline')).toBe('write');
  });

  it('every detail binds its path params, is strict and accepts its own examples', () => {
    expect(lifecycleDetails.map((d) => d.id).sort()).toEqual(lifecycleOps.map((o) => o.id).sort());
    for (const d of lifecycleDetails) {
      const op = findOpById(d.id)!;
      const shape = (d.input as z.ZodObject<z.ZodRawShape>).shape;
      for (const seg of op.path.split('/')) {
        if (seg.startsWith(':') && seg !== ':orgSlug')
          expect(shape, d.id).toHaveProperty(seg.slice(1));
      }
      expect(d.examples.length, d.id).toBeGreaterThan(0);
      for (const ex of d.examples) {
        expect(d.input.safeParse(ex.args).success, `${d.id}: ${ex.summary}`).toBe(true);
      }
      expect(d.input.safeParse({ ...d.examples[0]!.args, unknownKey: 'x' }).success, d.id).toBe(
        false,
      );
    }
  });

  it('the AI settings are an op now (G4), with the same bounds the settings service enforces', () => {
    expect(isNever('GET', `${ORG}/copilot/settings/`)).toBe(false);
    expect(isNever('PATCH', `${ORG}/copilot/settings/`)).toBe(false);
    expect(AI_SETTINGS_BOUNDS).toEqual({
      memberSharePercent: [AI_MEMBER_SHARE_MIN_PERCENT, AI_MEMBER_SHARE_MAX_PERCENT],
      conversationRetentionDays: [
        AI_CONVERSATION_RETENTION_MIN_DAYS,
        AI_CONVERSATION_RETENTION_MAX_DAYS,
      ],
      membersPerPatch: AI_SETTINGS_MEMBERS_PER_PATCH,
    });
  });
});
