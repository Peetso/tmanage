import { parseIpRange, rangesOverlap } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { platformAuditFor } from '../platform-admin/platform-audit.service.js';
import type { PlatformRequestContext } from '../platform-admin/platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import {
  SOURCE_LABEL_KINDS,
  SourceLabelMatcher,
  isSourceLabelKind,
  parseLabelValue,
} from './source-labels.js';
import type { SourceLabel } from './source-labels.js';
import type { SourceLabelStore } from './source-labels.repository.js';

/**
 * SEC-TRACKER (gap 2) — `POST /v1/platform/security/source-labels` `{ value, label, note? }` and
 * `DELETE /v1/platform/security/source-labels/:id`. Platform admins with `platform.settings.edit`
 * behind a fresh step-up (the controller's guard); each write with its platform audit row.
 *
 * The label is read by the attack tracker only (`attack-tracks.service.ts`); see `source-labels.ts`
 * for what it never changes.
 */

export const SOURCE_LABELS_SERVICE = Symbol.for('tmanage.SourceLabelsService');

const conflict = (message: string): ApiError =>
  new ApiError(409, 'conflict', message, [{ field: 'value', message }]);

export class SourceLabelsService {
  constructor(
    private readonly store: SourceLabelStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The matcher for one read (the table is small). */
  async matcher(): Promise<SourceLabelMatcher> {
    return new SourceLabelMatcher(await this.store.list());
  }

  async add(
    actor: PlatformAdminActor,
    raw: { readonly value?: unknown; readonly label?: unknown; readonly note?: unknown },
    context: PlatformRequestContext,
  ): Promise<SourceLabel> {
    const parsed = typeof raw.value === 'string' ? parseLabelValue(raw.value) : null;
    if (parsed === null) {
      throw new ApiError(400, 'validation_failed', 'Check the address.', [
        { field: 'value', message: 'An IP address or a CIDR of at most /24 (IPv4) or /48 (IPv6).' },
      ]);
    }
    if (!isSourceLabelKind(raw.label)) {
      throw new ApiError(400, 'validation_failed', 'Check the label.', [
        { field: 'label', message: SOURCE_LABEL_KINDS.join(' or ') },
      ]);
    }
    const label = raw.label;
    const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 190) : '';
    for (const existing of await this.store.list()) {
      const range = parseIpRange(existing.value);
      if (range !== null && rangesOverlap(range, parsed.range)) {
        throw conflict(
          `This overlaps the labelled entry ${existing.value}. Remove that label first.`,
        );
      }
    }
    const created = await this.store.add(
      { value: parsed.value, label, note: note === '' ? null : note, createdAt: this.now() },
      (id) =>
        platformAuditFor(actor, context, {
          action: 'platform.source_label_added',
          targetType: 'platform',
          targetId: id,
          targetLabel: `${label}:${parsed.value}`,
          reason: null,
        }),
    );
    if (created === null) throw conflict(`This overlaps the labelled entry ${parsed.value}.`);
    return created;
  }

  async remove(
    actor: PlatformAdminActor,
    id: string,
    context: PlatformRequestContext,
  ): Promise<void> {
    if (!/^[0-9a-f-]{36}$/u.test(id)) throw new ApiError(404, 'not_found', 'Not found.');
    const removed = await this.store.remove(
      id,
      platformAuditFor(actor, context, {
        action: 'platform.source_label_removed',
        targetType: 'platform',
        targetId: id,
        targetLabel: null,
        reason: null,
      }),
    );
    if (!removed) throw new ApiError(404, 'not_found', 'Not found.');
  }
}
