import { describe, expect, it } from 'vitest';
import {
  MATRIX_KINDS,
  NOTIFICATION_ROUTES,
  belongsInDigest,
  decideDelivery,
  digestParityGaps,
  effectiveMatrixCell,
  kindChannelAvailable,
  matrixKindOf,
  parseForcedEmailKinds,
  parseStoredMatrix,
  routeFor,
} from './routing.js';

describe('notification routing (53-15)', () => {
  it('routes every catalogued type to a kind, and every kind has at least one type', () => {
    for (const kind of MATRIX_KINDS) {
      expect(Object.values(NOTIFICATION_ROUTES).some((r) => r.group === kind)).toBe(true);
      expect(kindChannelAvailable(kind, 'in_app')).toBe(true);
      expect(kindChannelAvailable(kind, 'digest')).toBe(true);
    }
  });

  it('keeps digest parity: every member-facing mailable type can be digested', () => {
    expect(digestParityGaps()).toEqual([]);
    const broken = { x: { ...NOTIFICATION_ROUTES['review.approved.v1']!, digest: false } };
    expect(digestParityGaps(broken)).toEqual(['x']);
  });

  it('places an uncatalogued type by its prefix, and mentions by suffix', () => {
    expect(matrixKindOf('review.something_new.v1')).toBe('file');
    expect(matrixKindOf('task.mentioned.v1')).toBe('mention');
    expect(matrixKindOf('security.alert.v1')).toBeNull();
    expect(routeFor('totally.unknown').group).toBe('work_item');
  });

  it('builds the effective cell from profile defaults, saved choices and the company force', () => {
    const calm = { profile: 'calm' as const, kindEnabled: undefined, stored: {} };
    expect(effectiveMatrixCell({ ...calm, kind: 'file', forcedEmail: false })).toEqual({
      inApp: true,
      email: false,
      digest: true,
    });
    expect(effectiveMatrixCell({ ...calm, kind: 'mention', forcedEmail: false })).toEqual({
      inApp: true,
      email: true,
      digest: false,
    });
    const off = { ...calm, kindEnabled: false, stored: { client_request: { email: false } } };
    expect(effectiveMatrixCell({ ...off, kind: 'client_request', forcedEmail: true })).toEqual({
      inApp: true,
      email: true,
      digest: false,
    });
  });

  it('decides delivery: off kind silences, account notices always go, clients unchanged', () => {
    const off = { inApp: false, email: true, digest: true };
    expect(decideDelivery('review.approved.v1', off)).toEqual({ inApp: false, email: false });
    expect(decideDelivery('usage.threshold_reached.v1', off)).toEqual({ inApp: true, email: true });
    expect(decideDelivery('approval.requested.v1', null)).toEqual({ inApp: true, email: true });
    const quiet = { inApp: true, email: false, digest: true };
    expect(decideDelivery('message.mentioned.v1', quiet)).toEqual({ inApp: true, email: false });
    expect(belongsInDigest('message.mentioned.v1', quiet)).toBe(true);
    expect(belongsInDigest('webhook.endpoint_paused', quiet)).toBe(false);
  });

  it('parses stored blobs and forced csv defensively', () => {
    expect(parseStoredMatrix('{"file":{"email":true,"digest":"x"},"bogus":{}}')).toEqual({
      file: { email: true },
    });
    expect(parseStoredMatrix('not json')).toEqual({});
    expect(parseForcedEmailKinds('mention, client_request,nope')).toEqual([
      'client_request',
      'mention',
    ]);
  });
});
