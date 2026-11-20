'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { Button, InlineAlert, StateCapsule } from '@tmanage/ui';
import type { FilePreviewManifest } from '../../lib/api/file-preview';
import {
  capsuleStateFor,
  type FileReviewDecision,
  type FileReviewDecisions,
} from '../../lib/api/file-review-decisions';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import { useT } from '../../lib/i18n/use-t';
import { reviewOf } from './VersionsTab';
import { ViewerIcon } from './viewer-icons';
import './viewer-versions.css';

export interface DecisionRailProps {
  readonly organizationSlug: string;
  readonly manifest: FilePreviewManifest;
  readonly review: FileReviewDecisions | undefined;
  /** Who the person asking for changes is talking to ("Tell Lina what to change"). */
  readonly pending: boolean;
  readonly error: string | null;
  readonly onDecide: (decision: FileReviewDecision, note: string | null) => void;
  /** The team's next step after changes were asked for: upload the next version. */
  readonly onUploadNext?: () => void;
}

/**
 * R4 slice 11 — the decision card at the foot of the comments rail (Figma V-33 `464:26551`,
 * V-34 `466:26253` / `466:26677`).
 *
 * - **Plain file:** "Your decision on v3" with the version's state capsule; Approve v3 (lime, with
 *   a check) and Request changes (outline). Requesting changes opens "What should change?" — a note
 *   is required ("A note is needed to request changes."). Below, the history: one capsule per
 *   decision with the version, who and when.
 * - **Recorded:** the capsule of the newest decision on this version and "Youssef Kamal approved v3
 *   · 1 Nov 10:42" with the note; after a request for changes the team sees "Upload v4 to answer".
 * - **Deliverable:** the decision goes through the deliverable's approval — an alert and
 *   "Open approval" (V-33 deliverable variant `465:25984`); no second decision form.
 *
 * Nothing is shown to a person who may not decide and has nothing to read.
 */
export function DecisionRail({
  organizationSlug,
  manifest,
  review,
  pending,
  error,
  onDecide,
  onUploadNext,
}: DecisionRailProps) {
  const t = useT();
  const format = useDisplayFormatters();
  const id = useId();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [noteMissing, setNoteMissing] = useState(false);

  const here = manifest.versions.versions.find((v) => v.fileAssetId === manifest.file.id);
  const versionNo = here?.versionNo ?? 1;
  const newest = manifest.versions.versions.reduce((max, v) => Math.max(max, v.versionNo), 0);
  const facts = reviewOf(review, manifest.file.id);
  const decided = facts?.latestDecision ?? null;
  const history = review?.history ?? [];
  const canDecide = manifest.capabilities.canDecide;
  const short = (no: number) => t('Viewer.version.short').replace('{no}', String(no));

  if (manifest.decisionContext.kind === 'deliverable') {
    const { deliverableId } = manifest.decisionContext;
    return (
      <section className="tm-decision" aria-labelledby={`${id}-title`}>
        <h2 id={`${id}-title`} className="tm-decision__title">
          {t('ViewerDecision.title').replace('{no}', short(versionNo))}
        </h2>
        <InlineAlert tone="client">{t('ViewerDecision.deliverableAlert')}</InlineAlert>
        {deliverableId ? (
          <Link
            className="tm-button tm-button--ink tm-button--accessible tm-decision__wide"
            href={`/${organizationSlug}/projects/${encodeURIComponent(manifest.file.projectId)}/deliverables/${encodeURIComponent(deliverableId)}`}
          >
            {t('ViewerDecision.openApproval')}
          </Link>
        ) : null}
      </section>
    );
  }

  if (!canDecide && !decided && history.length === 0) return null;

  const stateWord = facts ? t(`ViewerVersions.state.${facts.state}`) : null;

  function submitChanges() {
    const trimmed = note.trim();
    if (trimmed === '') {
      setNoteMissing(true);
      return;
    }
    onDecide('changes_requested', trimmed);
  }

  return (
    <section className="tm-decision" aria-labelledby={`${id}-title`}>
      <div className="tm-decision__head">
        <h2 id={`${id}-title`} className="tm-decision__title">
          {t('ViewerDecision.title').replace('{no}', short(versionNo))}
        </h2>
        {facts && stateWord ? (
          <StateCapsule state={capsuleStateFor(facts.state)}>{stateWord}</StateCapsule>
        ) : null}
      </div>

      {decided ? (
        <div className="tm-decision__recorded" aria-live="polite">
          <p className="tm-decision__line">
            {t(
              decided.decision === 'approved'
                ? 'ViewerDecision.approvedBy'
                : 'ViewerDecision.changesBy',
            )
              .replace('{name}', decided.decidedBy.displayName ?? t('ViewerVersions.someone'))
              .replace('{no}', short(decided.versionNo))
              .replace('{date}', format.dateTime(decided.createdAt))}
          </p>
          {decided.note ? (
            <blockquote className="tm-decision__note" dir="auto">
              {decided.note}
            </blockquote>
          ) : null}
          {decided.decision === 'changes_requested' &&
          onUploadNext &&
          versionNo === newest &&
          manifest.capabilities.canUploadVersion ? (
            <div className="tm-decision__next">
              <p className="tm-viewer-rail__note">
                {t('ViewerDecision.uploadHint')
                  .replace('{next}', short(newest + 1))
                  .replace('{open}', String(facts?.openThreads ?? 0))}
              </p>
              <Button type="button" tone="ink" size="accessible" onClick={onUploadNext}>
                <ViewerIcon name="plus" />
                {t('ViewerDecision.uploadNext').replace('{next}', short(newest + 1))}
              </Button>
            </div>
          ) : null}
        </div>
      ) : canDecide ? (
        <>
          <div className="tm-decision__buttons">
            <Button
              type="button"
              tone="lime"
              size="accessible"
              loading={pending && !asking}
              loadingLabel={t('ViewerDecision.saving')}
              onClick={() => {
                setAsking(false);
                onDecide('approved', null);
              }}
            >
              <ViewerIcon name="check" />
              {t('ViewerDecision.approve').replace('{no}', short(versionNo))}
            </Button>
            <Button
              type="button"
              tone="outline"
              size="accessible"
              aria-expanded={asking}
              aria-controls={`${id}-changes`}
              onClick={() => setAsking((open) => !open)}
            >
              {t('ViewerDecision.requestChanges')}
            </Button>
          </div>
          {asking ? (
            <form
              noValidate
              id={`${id}-changes`}
              className="tm-decision__form"
              onSubmit={(event) => {
                event.preventDefault();
                submitChanges();
              }}
            >
              <label htmlFor={`${id}-note`} className="tm-decision__label">
                {t('ViewerDecision.noteLabel')}
              </label>
              <textarea
                id={`${id}-note`}
                className="tm-decision__textarea"
                rows={3}
                dir="auto"
                value={note}
                placeholder={t('ViewerDecision.notePlaceholder').replace('{no}', short(versionNo))}
                aria-invalid={noteMissing ? true : undefined}
                aria-describedby={noteMissing ? `${id}-note-error` : undefined}
                onChange={(event) => {
                  setNote(event.target.value);
                  if (event.target.value.trim() !== '') setNoteMissing(false);
                }}
              />
              {noteMissing ? (
                <p id={`${id}-note-error`} className="tm-decision__error" role="alert">
                  <ViewerIcon name="close" />
                  {t('ViewerDecision.noteRequired')}
                </p>
              ) : null}
              <div className="tm-decision__form-actions">
                <Button type="button" tone="text" onClick={() => setAsking(false)}>
                  {t('ViewerDecision.cancel')}
                </Button>
                <Button
                  type="submit"
                  tone="ink"
                  loading={pending}
                  loadingLabel={t('ViewerDecision.saving')}
                >
                  {t('ViewerDecision.sendChanges')}
                </Button>
              </div>
            </form>
          ) : null}
        </>
      ) : null}

      {error ? (
        <InlineAlert tone="danger" title={t('ViewerDecision.error')} live>
          {error}
        </InlineAlert>
      ) : null}

      {history.length > 0 ? (
        <div className="tm-decision__history">
          <h3 className="tm-decision__history-title">{t('ViewerDecision.history')}</h3>
          <ul className="tm-decision__history-list">
            {history.map((entry) => (
              <li key={entry.id} className="tm-decision__history-item">
                <StateCapsule state={capsuleStateFor(entry.decision)}>
                  {t(`ViewerVersions.state.${entry.decision}`)}
                </StateCapsule>
                <span className="tm-decision__history-meta">
                  {t('ViewerDecision.historyLine')
                    .replace('{no}', short(entry.versionNo))
                    .replace('{name}', entry.decidedBy.displayName ?? t('ViewerVersions.someone'))
                    .replace('{date}', format.dateTime(entry.createdAt))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
