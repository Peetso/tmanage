import { describe, expect, it } from 'vitest';
import { CHAT_TOOLS, META_TOOL_NAMES, planToolCall } from './ai-chat-tools.js';

/**
 * 2026-11-23: every in-app AI answer failed with "Our AI provider is not answering" because the
 * find tool's schema carried `minimum`/`maximum`, which strict tools reject with a 400.
 */
const BOUND =
  /"(minimum|maximum|exclusiveMinimum|exclusiveMaximum|multipleOf|minLength|maxLength)"/;

describe('chat tools', () => {
  it('carry no keyword a strict tool schema rejects', () => {
    for (const tool of CHAT_TOOLS) {
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toMatch(BOUND);
    }
  });

  it('keeps the find limit between 1 and 20 on the server', () => {
    const limitOf = (limit: unknown) => {
      const plan = planToolCall(META_TOOL_NAMES.find, { query: 'x', limit } as never);
      return plan.kind === 'run' ? plan.args['limit'] : undefined;
    };
    expect(limitOf(5)).toBe(5);
    expect(limitOf(500)).toBe(20);
    expect(limitOf(0)).toBe(1);
    expect(limitOf(null)).toBe(10);
    expect(limitOf('7')).toBe(10);
  });
});
