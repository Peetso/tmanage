import { describe, expect, it } from 'vitest';
import { WEBHOOK_EVENT_KINDS, webhookEventMessageKey } from '../src/lib/api/webhooks';

describe('webhookEventMessageKey (C6-webhooks)', () => {
  it('maps every event kind to a flat catalog key without inner dots in the kind part', () => {
    expect(webhookEventMessageKey('client_request.created')).toBe(
      'WebhookEndpointsScreen.eventKind.client_request_created',
    );
    for (const kind of WEBHOOK_EVENT_KINDS) {
      expect(webhookEventMessageKey(kind).split('.')).toHaveLength(3);
    }
  });
});
