import { describe, expect, it } from 'vitest';
import { channelFromMetadata } from './activity-log.service.js';

/**
 * AUT-08. The activity feed marks a move "via AI assistant" when the audit row's metadata
 * carries `actor_channel: 'ai_assistant'` — the stamp the audit append writes for a request on
 * the personal-access-token (MCP) channel. The column is free-form JSON, so the reader must
 * fail closed to `null` on every other shape rather than surface a stray value as a channel.
 */
describe('channelFromMetadata', () => {
  it('reads the AI-assistant channel back from the stamped metadata', () => {
    expect(channelFromMetadata({ actor_channel: 'ai_assistant' })).toBe('ai_assistant');
    expect(channelFromMetadata({ http_status: 200, actor_channel: 'ai_assistant' })).toBe(
      'ai_assistant',
    );
  });

  it('is null for an ordinary move and for any non-matching shape', () => {
    expect(channelFromMetadata({})).toBeNull();
    expect(channelFromMetadata({ actor_channel: 'web' })).toBeNull();
    expect(channelFromMetadata({ actor_channel: 42 })).toBeNull();
    expect(channelFromMetadata(null)).toBeNull();
    expect(channelFromMetadata(undefined)).toBeNull();
    expect(channelFromMetadata('ai_assistant')).toBeNull();
    expect(channelFromMetadata(['ai_assistant'])).toBeNull();
  });
});
