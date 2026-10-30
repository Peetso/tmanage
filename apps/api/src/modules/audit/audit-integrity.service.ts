import { hasCapability } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ChainVerifier } from './audit-chain.js';
import type { ChainBreak } from './audit-chain.js';
import { AuditChainRepository, VERIFY_PAGE_SIZE } from './audit-chain.repository.js';
import { AnchorSigner, anchorMessage, exportManifestMessage } from './audit-anchor-signer.js';
import type { AnchorKeyStatus } from './audit-anchor-signer.js';
import { auditCatalog } from './audit-catalog.js';
import type { AuditCatalogEntry } from './audit-catalog.js';

/**
 * 56-11 — integrity verification, the action catalog and the signed export head.
 *
 * **Read-only.** `verify` walks the organization's chained rows in `chain_seq` order and
 * recomputes every hash; it never writes. A break surfaces as a reason code and the **first** bad
 * row's id only — no metadata value, no actor, no later row. The walk is capped at
 * {@link MAX_VERIFY_EVENTS}; past it the report says `complete: false` and the head is not judged.
 *
 * **Scope.** The chain is the whole organization's, so `verify` needs `audit.read` *and*
 * organization-wide scope (the narrower reading of `12-PERMISSION-MATRIX` §2, as in
 * `AuditService.view`): an own-activity reader is refused with 403 rather than shown a summary of
 * other people's trail. The catalog is vocabulary and needs `audit.read` only. The export head is
 * part of the bulk export and needs `audit.export`.
 */

export const AUDIT_INTEGRITY_SERVICE = Symbol('AUDIT_INTEGRITY_SERVICE');

export const MAX_VERIFY_EVENTS = 100_000;

export type IntegrityStatus = 'intact' | 'broken' | 'not_started';

export interface AuditIntegrityReport {
  readonly status: IntegrityStatus;
  /** False when the walk hit {@link MAX_VERIFY_EVENTS} before the head. */
  readonly complete: boolean;
  readonly checkedEvents: number;
  /** Rows written before the chain started (unhashed, not verifiable). */
  readonly legacyEvents: number;
  /** Unhashed rows written after the chain started — a writer outside the chained path. */
  readonly unchainedEvents: number;
  readonly head: { readonly chainSeq: number; readonly headHash: string } | null;
  readonly chainStartedAt: string | null;
  readonly firstBreak: ChainBreak | null;
  readonly anchors: {
    readonly total: number;
    readonly matchedInWalk: number;
    readonly signedValid: number;
    readonly unsigned: number;
    readonly invalidSignature: number;
    readonly unknownKey: number;
  };
  readonly anchorKey: AnchorKeyStatus;
}

export interface AuditExportManifest {
  readonly chainSeq: number;
  readonly headHash: string;
  readonly lastEventId: string | null;
  readonly generatedAt: string;
  /** `v1:<keyId>:<hex>` under `AUDIT_ANCHOR_KEY`, or null when no key is configured. */
  readonly signature: string | null;
}

export class AuditIntegrityService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly chain: AuditChainRepository = new AuditChainRepository(),
    private readonly signer: AnchorSigner = AnchorSigner.fromEnv(process.env),
  ) {}

  catalog(principal: Principal): readonly AuditCatalogEntry[] {
    if (!hasCapability(principal.role, 'audit.read')) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'audit_read_denied');
    }
    return auditCatalog();
  }

  async verify(context: TenantContext, principal: Principal): Promise<AuditIntegrityReport> {
    if (!hasCapability(principal.role, 'audit.read') || !principal.hasOrgWideScope) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'audit_integrity_denied');
    }

    return this.database.read(context, async (runner) => {
      const head = await this.chain.readHead(runner, context);
      const counts = await this.chain.unchainedCounts(
        runner,
        context,
        head?.legacyLastEventId ?? null,
      );
      const anchorRows = head === null ? [] : await this.chain.anchors(runner, context);

      const anchorMap = new Map<number, string>();
      let signedValid = 0;
      let unsigned = 0;
      let invalidSignature = 0;
      let unknownKey = 0;
      for (const anchor of anchorRows) {
        if (head !== null && anchor.eventCount > 0 && anchor.eventCount <= head.chainSeq) {
          anchorMap.set(anchor.eventCount, anchor.headHash);
        }
        const verdict = this.signer.verify(
          anchorMessage({
            organizationId: context.organizationId,
            day: anchor.day,
            headHash: anchor.headHash,
            eventCount: anchor.eventCount,
          }),
          anchor.signature,
        );
        if (anchor.signature === null) unsigned += 1;
        else if (verdict === true) signedValid += 1;
        else if (verdict === false) invalidSignature += 1;
        else unknownKey += 1;
      }

      const verifier = new ChainVerifier(context.organizationId, anchorMap);
      let complete = true;
      if (head !== null) {
        let after = 0;
        let seen = 0;
        while (after < head.chainSeq) {
          const page = await this.chain.chainedPage(runner, context, after, VERIFY_PAGE_SIZE);
          // Rows appended after the head was read are beyond it and are left for the next run.
          const inScope = page.filter((row) => row.chainSeq <= head.chainSeq);
          for (const row of inScope) verifier.push(row);
          seen += inScope.length;
          if (inScope.length === 0) break;
          after = (inScope[inScope.length - 1] as { chainSeq: number }).chainSeq;
          if (seen >= MAX_VERIFY_EVENTS) {
            complete = after >= head.chainSeq;
            break;
          }
        }
      }
      const walk = verifier.finish(
        head === null
          ? null
          : { chainSeq: head.chainSeq, headHash: head.headHash, lastEventId: head.lastEventId },
        complete,
      );

      const status: IntegrityStatus =
        head === null
          ? 'not_started'
          : walk.firstBreak !== null || invalidSignature > 0
            ? 'broken'
            : 'intact';

      return {
        status,
        complete,
        checkedEvents: walk.checkedEvents,
        legacyEvents: counts.legacy,
        unchainedEvents: counts.unchained,
        head: head === null ? null : { chainSeq: head.chainSeq, headHash: head.headHash },
        chainStartedAt: head === null ? null : head.chainStartedAt.toISOString(),
        firstBreak: walk.firstBreak,
        anchors: {
          total: anchorRows.length,
          matchedInWalk: walk.anchorsChecked,
          signedValid,
          unsigned,
          invalidSignature,
          unknownKey,
        },
        anchorKey: this.signer.status,
      };
    });
  }

  /** The signed chain head that accompanies a bulk export (`export.sig`). */
  async exportManifest(context: TenantContext, principal: Principal): Promise<AuditExportManifest> {
    if (!hasCapability(principal.role, 'audit.export')) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'audit_export_denied');
    }
    const head = await this.database.read(context, (runner) =>
      this.chain.readHead(runner, context),
    );
    const generatedAt = new Date().toISOString();
    const chainSeq = head?.chainSeq ?? 0;
    const headHash = head?.headHash ?? '';
    return {
      chainSeq,
      headHash,
      lastEventId: head?.lastEventId ?? null,
      generatedAt,
      signature:
        head === null
          ? null
          : this.signer.sign(
              exportManifestMessage({
                organizationId: context.organizationId,
                chainSeq,
                headHash,
                generatedAt,
              }),
            ),
    };
  }
}
