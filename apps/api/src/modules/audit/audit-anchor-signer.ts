import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseFieldCipherKeys } from '@tmanage/domain/field-cipher';
import { canonicalJson } from './audit-chain.js';

/**
 * 56-11 — the daily anchor's HMAC, API side (the verifier). The worker's `jobs/audit-anchor.ts`
 * writes signatures in exactly this format; both sides pin the same golden vector in their tests.
 *
 * `AUDIT_ANCHOR_KEY` uses the 56-02 keyring format (`<id>:<base64 32 bytes>` entries separated by
 * `;`, highest id active, older ids still verify). The key is optional: absent, anchors are written
 * with `signature = NULL` and the integrity report says `anchorKey: 'absent'`; malformed, the same
 * with `'invalid'`. Boot never fails on it.
 *
 * Signature: `v1:<keyId>:<hex HMAC-SHA-256>` over a domain-separated canonical JSON array.
 */

export type AnchorKeyStatus = 'configured' | 'absent' | 'invalid';

export interface AnchorFields {
  readonly organizationId: string;
  /** `YYYY-MM-DD`, UTC. */
  readonly day: string;
  readonly headHash: string;
  readonly eventCount: number;
}

export function anchorMessage(anchor: AnchorFields): string {
  return canonicalJson([
    'tmanage.audit.anchor.v1',
    anchor.organizationId,
    anchor.day,
    anchor.headHash,
    anchor.eventCount,
  ]);
}

export function exportManifestMessage(manifest: {
  readonly organizationId: string;
  readonly chainSeq: number;
  readonly headHash: string;
  readonly generatedAt: string;
}): string {
  return canonicalJson([
    'tmanage.audit.export.v1',
    manifest.organizationId,
    manifest.chainSeq,
    manifest.headHash,
    manifest.generatedAt,
  ]);
}

export class AnchorSigner {
  private constructor(
    readonly status: AnchorKeyStatus,
    private readonly active: { readonly id: string; readonly key: Buffer } | null,
    private readonly byId: ReadonlyMap<string, Buffer>,
  ) {}

  static fromEnv(env: { readonly AUDIT_ANCHOR_KEY?: string | undefined }): AnchorSigner {
    const raw = env.AUDIT_ANCHOR_KEY;
    if (raw === undefined || raw.trim() === '') return new AnchorSigner('absent', null, new Map());
    try {
      const ring = parseFieldCipherKeys(raw);
      return new AnchorSigner('configured', ring.active, ring.byId);
    } catch {
      return new AnchorSigner('invalid', null, new Map());
    }
  }

  /** `null` when no key is configured — the row is written unsigned, never refused. */
  sign(message: string): string | null {
    if (this.active === null) return null;
    return `v1:${this.active.id}:${hmacHex(this.active.key, message)}`;
  }

  /** `null` = cannot tell (unsigned, or the key id is not in the ring); otherwise valid or not. */
  verify(message: string, signature: string | null): boolean | null {
    if (signature === null) return null;
    const parts = signature.split(':');
    if (parts.length !== 3 || parts[0] !== 'v1') return false;
    const key = this.byId.get(parts[1] as string);
    if (key === undefined) return null;
    const expected = Buffer.from(hmacHex(key, message), 'hex');
    const presented = Buffer.from(parts[2] as string, 'hex');
    return expected.length === presented.length && timingSafeEqual(expected, presented);
  }
}

function hmacHex(key: Buffer, message: string): string {
  return createHmac('sha256', key).update(message, 'utf8').digest('hex');
}
