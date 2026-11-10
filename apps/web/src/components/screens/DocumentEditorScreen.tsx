'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { DocumentLifecycleActions } from '../docs/DocumentLifecycleActions';
import { DocsSidebar } from '../docs/DocsSidebar';
import { DocTitleEditor, type RenameStatus } from '../docs/DocTitleEditor';
import { DocShareDialog } from '../docs/DocShareDialog';
import '../docs/docs-shell.css';
import { diffLines, initialsFor, isArabic, rtlLine, tagFor } from '../docs/doc-markdown';
import type { Editor } from '@tiptap/core';
import { DocEditor } from '../docs/editor/DocEditor';
import { DocCollabBar, DocViewOnlyBanner } from '../docs/editor/DocCollabBar';
import { joinCollab } from '../docs/editor/collab-api';
import { newClientId, useDocCollab } from '../docs/editor/use-doc-collab';
import {
  backupToRestore,
  clearDraftBackup,
  draftKey,
  draftOwner,
  flushDraft,
  readDraftBackup,
  writeDraftBackup,
} from '../docs/editor/unsaved-draft';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  getDocument,
  getDocumentPresence,
  getDocumentSharing,
  getDocumentVersion,
  listDocumentVersions,
  restoreDocumentVersion,
  saveDocumentVersion,
  setDocumentAudience,
  touchDocumentPresence,
  type DocumentBodyFormat,
  type DocumentVersionSummary,
} from '../../lib/api/documents';
import { ApiRequestError } from '../../lib/api/errors';
import { fetchMyProfile } from '../../lib/api/member-profile';
import {
  isTransientStatus,
  PART_ATTEMPTS,
  retryDelayMs,
  uploadProjectFile,
} from '../../lib/api/uploads';
import { listProjects } from '../../lib/api/projects';
import type { ApiClient } from '../../lib/api/client';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface DocumentEditorScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** The document being edited — its id arrives in the route path. */
  documentId: string;
  client?: ApiClient;
  /** How long typing must pause before the draft is saved. Tests pass a short one. */
  autosaveDelayMs?: number;
  /** How often presence is sent and read (15 s). Tests pass a short one. */
  presenceIntervalMs?: number;
}

/**
 * **DOC-02 editor** — Figma 383:3806 / 383:4019 (A15), rich since R5 (483:28731).
 *
 * The Slack-like docs column on the start side; a top bar with the breadcrumb ("Docs / <project>"),
 * who else is editing, the save state ("Saved · just now"), Share and Publish (the client audience,
 * offered only when the API says the caller may publish); then the rich editor (`DocEditor`: fixed
 * toolbar, "/" menu, tables, images, embeds, mentions) on the sheet with the title, the Draft pill
 * with who can see it and — while the body is empty — "Or start from a template".
 *
 * **Every pause is a save**, as HTML (`format: 'html'`); a Markdown body from the textarea era is
 * converted when it opens and saved back as HTML on the first edit. Each save names the version
 * it was made on (`expectedVersionNo`): a newer save by someone else answers 409 and the "Newer
 * version" banner (Figma 486:29604) offers Reload, which drops the draft. While the editor has
 * focus, presence is sent every 15 s; whoever else is editing shows as a chip in the top bar.
 */
export function DocumentEditorScreen({
  organizationSlug,
  organizationName,
  documentId,
  client,
  autosaveDelayMs = 1200,
  presenceIntervalMs = 15_000,
}: DocumentEditorScreenProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const tOr = useTOr();
  const locale = useActiveLocale();

  const document = useQuery({
    queryKey: ['document', organizationSlug, documentId],
    queryFn: () => getDocument(api, organizationSlug, documentId),
  });
  const versions = useQuery({
    queryKey: ['document-versions', organizationSlug, documentId],
    queryFn: () => listDocumentVersions(api, organizationSlug, documentId),
  });
  const sharing = useQuery({
    queryKey: ['document-sharing', organizationSlug, documentId],
    queryFn: () => getDocumentSharing(api, organizationSlug, documentId),
  });
  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });
  const presence = useQuery({
    queryKey: ['document-presence', organizationSlug, documentId],
    queryFn: () => getDocumentPresence(api, organizationSlug, documentId),
    refetchInterval: presenceIntervalMs,
  });
  const me = useQuery({
    queryKey: ['my-profile', organizationSlug],
    queryFn: () => fetchMyProfile(api, organizationSlug),
  });
  // 53-10: live co-editing. The API answers 404 while its switch is off; the editor then keeps
  // the single-writer autosave below.
  const collabJoin = useQuery({
    queryKey: ['document-collab', organizationSlug, documentId],
    queryFn: () => joinCollab(api, organizationSlug, documentId),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const collab = collabJoin.isSuccess ? collabJoin.data : null;
  const [collabEditor, setCollabEditor] = useState<Editor | null>(null);
  const [clientId] = useState(newClientId);

  // `null` = not edited yet: the editor shows the stored body. Otherwise the editor's HTML.
  const [draft, setDraft] = useState<string | null>(null);
  // The newest version the editor was loaded on (or last saved); every save names it.
  const [baseVersionNo, setBaseVersionNo] = useState<number | null>(null);
  // Bumped to remount the editor on a newer body (Reload, Restore).
  const [editorKey, setEditorKey] = useState(0);
  const [conflict, setConflict] = useState<'banner' | 'quiet' | null>(null);
  const [focused, setFocused] = useState(false);
  const [selfId, setSelfId] = useState<string | null>(null);
  // The last body this editor saved: the server's sanitised copy may differ in markup, and that
  // must not read as a new edit (a save loop).
  const [savedDraft, setSavedDraft] = useState<string | null>(null);
  // FIX4 item 4 (D2): saves that failed in a row for a passing reason (a starting server, a dropped
  // connection). The autosave tries the same draft again after a growing pause.
  const [saveFailures, setSaveFailures] = useState(0);
  // A draft the server refused for good (not a conflict): it is not sent again until it changes.
  const [refusedDraft, setRefusedDraft] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [shareOpen, setShareOpen] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  // F2: the title rename's own save state, shown in the same place as the body's.
  const [renameStatus, setRenameStatus] = useState<RenameStatus>('idle');
  // Keep the newest `now` when the document (re)loads, so a fresh document reads "just now".
  const loadedAt = document.dataUpdatedAt;
  useEffect(() => {
    if (loadedAt > 0) setNow(Date.now());
  }, [loadedAt]);

  const data = document.data;
  const format: DocumentBodyFormat = data?.bodyFormat === 'html' ? 'html' : 'markdown';
  const stored = data && data.body.trim() !== '' ? data.body : '';
  const body = draft ?? stored;
  const bodyFormat: DocumentBodyFormat = draft !== null ? 'html' : format;

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['document', organizationSlug, documentId] }),
      queryClient.invalidateQueries({
        queryKey: ['document-versions', organizationSlug, documentId],
      }),
    ]);
  };

  // B-N2: the save in flight, so leaving the page can save the newest body after it.
  const inflight = useRef<{
    readonly html: string;
    readonly promise: Promise<DocumentVersionSummary>;
  } | null>(null);
  // FIX5 security review L6: the backup belongs to the signed-in person; `null` until known
  // (nothing is read or written for an unknown account).
  const backupKey = me.data
    ? draftKey(organizationSlug, draftOwner(me.data.email), documentId)
    : null;
  const save = useMutation({
    mutationFn: (html: string) => {
      const promise = saveDocumentVersion(api, organizationSlug, documentId, html, {
        format: 'html',
        ...(baseVersionNo !== null && baseVersionNo > 0
          ? { expectedVersionNo: baseVersionNo }
          : {}),
      });
      inflight.current = { html, promise };
      return promise.finally(() => {
        if (inflight.current?.promise === promise) inflight.current = null;
      });
    },
    onSuccess: async (saved, html) => {
      if (latest.current.draft === html && backupKey) clearDraftBackup(backupKey);
      setSavedDraft(html);
      setSaveFailures(0);
      setRefusedDraft(null);
      setBaseVersionNo(saved.versionNo);
      setSelfId(saved.editedByUserId);
      setSavedAt(Date.now());
      setNow(Date.now());
      await invalidate();
    },
    onError: (error, html) => {
      if (error instanceof ApiRequestError && error.status === 409) setConflict('banner');
      else if (isTransientSaveError(error)) setSaveFailures((count) => count + 1);
      else setRefusedDraft(html);
    },
  });

  /** Reload after a conflict: drop the draft and open the newest body in a fresh editor. */
  async function reload() {
    setConflict(null);
    setDraft(null);
    setBaseVersionNo(null);
    save.reset();
    await Promise.all([document.refetch(), versions.refetch()]);
    setEditorKey((key) => key + 1);
  }

  const restore = useMutation({
    mutationFn: (versionNo: number) =>
      restoreDocumentVersion(api, organizationSlug, documentId, versionNo),
    onSuccess: async (restored) => {
      setDraft(null);
      setSelectedVersion(null);
      setBaseVersionNo(restored.versionNo);
      setSavedAt(Date.now());
      await invalidate();
      setEditorKey((key) => key + 1);
    },
  });

  const publish = useMutation({
    mutationFn: () => setDocumentAudience(api, organizationSlug, documentId, 'client'),
    onSuccess: (next) => {
      queryClient.setQueryData(['document-sharing', organizationSlug, documentId], next);
    },
  });

  const comparison = useQuery({
    queryKey: ['document-version', organizationSlug, documentId, selectedVersion],
    queryFn: () => getDocumentVersion(api, organizationSlug, documentId, selectedVersion as number),
    enabled: selectedVersion !== null,
  });

  // The version the editor is loaded on, once the history has come in.
  const newestNo = versions.data?.reduce((max, version) => Math.max(max, version.versionNo), 0);
  useEffect(() => {
    if (baseVersionNo === null && newestNo !== undefined) setBaseVersionNo(newestNo);
  }, [baseVersionNo, newestNo]);

  // B-N2: a body typed here and never saved (a closed tab, a failed last save) is opened again,
  // when nobody has saved a newer version since. `undefined` until that is decided; the editor
  // waits for it, because it reads its body once.
  const [restored, setRestored] = useState<string | null | undefined>(undefined);
  const historyKnown = newestNo !== undefined || versions.isError;
  useEffect(() => {
    if (restored !== undefined || !data || collabJoin.isPending || me.isPending) return;
    if (collab || !historyKnown || backupKey === null) {
      if (collab || backupKey === null) setRestored(null);
      return;
    }
    const backup = readDraftBackup(backupKey);
    const pick = backupToRestore(backup, stored, newestNo ?? 0);
    if (pick === null) {
      if (backup !== null) clearDraftBackup(backupKey);
      setRestored(null);
      return;
    }
    setRestored(pick.html);
    setDraft(pick.html);
  }, [
    restored,
    data,
    collab,
    collabJoin.isPending,
    me.isPending,
    historyKnown,
    backupKey,
    stored,
    newestNo,
  ]);

  // Autosave: a pause in typing saves the draft once, if it differs from what is stored. A
  // conflict stops it until Reload.
  //
  // FIX4 item 4 (D2): body text typed right after a rename was lost. Two causes, both fixed here:
  // 1. A second save started while the first was still in flight named the old version, so it
  //    answered 409 and the conflict banner's Reload dropped the draft. Saves now run one at a
  //    time: the next waits for the one in flight and names the version it produced.
  // 2. A save that failed for a passing reason (the server restarting after a deploy) was never
  //    tried again unless the person typed more. It is now retried with a growing pause.
  const { mutate: saveNow, isPending: saving } = save;
  useEffect(() => {
    if (collab || conflict || saving || draft === null || draft.trim() === '' || draft === stored)
      return undefined;
    if (draft === savedDraft || draft === refusedDraft) return undefined;
    if (saveFailures >= PART_ATTEMPTS) return undefined;
    const delay = saveFailures > 0 ? retryDelayMs(saveFailures) : autosaveDelayMs;
    const timer = setTimeout(() => saveNow(draft), delay);
    return () => clearTimeout(timer);
  }, [
    draft,
    stored,
    savedDraft,
    refusedDraft,
    saveFailures,
    saving,
    autosaveDelayMs,
    saveNow,
    conflict,
    collab,
  ]);

  // A new draft starts a fresh run of retries.
  useEffect(() => {
    setSaveFailures(0);
  }, [draft]);

  // Leaving the page with typing that is not saved yet asks first.
  const unsaved =
    !collab && draft !== null && draft.trim() !== '' && draft !== stored && draft !== savedDraft;
  // B-N2: leaving the doc never loses the body. A copy waits in this browser until it is saved,
  // and leaving the page inside the app (a link, the sidebar, a shortcut) saves it at once.
  const latest = useRef({ unsaved, draft, baseVersionNo, api, backupKey });
  latest.current = { unsaved, draft, baseVersionNo, api, backupKey };
  useEffect(() => {
    if (unsaved && draft !== null && backupKey) {
      writeDraftBackup(backupKey, { html: draft, baseVersionNo });
    }
  }, [unsaved, draft, baseVersionNo, backupKey]);
  useEffect(
    () => () => {
      const leaving = latest.current;
      if (!leaving.unsaved || leaving.draft === null) return;
      void flushDraft(leaving.draft, leaving.baseVersionNo, inflight.current, (html, expected) =>
        saveDocumentVersion(leaving.api, organizationSlug, documentId, html, {
          format: 'html',
          ...(expected !== null && expected > 0 ? { expectedVersionNo: expected } : {}),
        }),
      )
        .then(() => {
          if (leaving.backupKey) clearDraftBackup(leaving.backupKey);
          void queryClient.invalidateQueries({
            queryKey: ['document', organizationSlug, documentId],
          });
        })
        .catch(() => undefined);
    },
    // Runs once, when the page is left; the newest values are read from `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [organizationSlug, documentId],
  );

  useEffect(() => {
    if (!unsaved) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  const live = useDocCollab({
    editor: collabEditor,
    api,
    organizationSlug,
    documentId,
    join: collab,
    clientId,
    ...(selfId ? { selfUserId: selfId } : {}),
    onResync: () => {
      void collabJoin.refetch().then(() => setEditorKey((key) => key + 1));
    },
  });

  // Presence: "I am editing" now and every 15 s while the editor has focus.
  useEffect(() => {
    if (!focused) return undefined;
    const touch = () => {
      touchDocumentPresence(api, organizationSlug, documentId).catch(() => undefined);
    };
    touch();
    const timer = setInterval(touch, presenceIntervalMs);
    return () => clearInterval(timer);
    // `api` is a new object per render when no client is passed; the route is what counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, organizationSlug, documentId, presenceIntervalMs]);
  const others = (presence.data ?? []).filter(
    (editor) => editor.userId !== selfId && editor.name !== me.data?.displayName,
  );

  // "Saved · just now" ages into a clock time after a minute.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const projectName =
    (Array.isArray(projects.data) ? projects.data : []).find(
      (project) => project.id === data?.projectId,
    )?.name ?? '';
  const published = sharing.data?.audience === 'client';
  const rows = versions.data ?? [];
  // Newest first; the newest is "Current" and is what every other version is compared with.
  const ordered = [...rows].sort((a, b) => b.versionNo - a.versionNo);
  const currentNo = ordered[0]?.versionNo ?? null;
  const people = sharing.data?.collaborators ?? [];
  const authorOf = (userId: string) =>
    people.find((person) => person.userId === userId)?.displayName ?? '';
  const pickedRow = rows.find((version) => version.versionNo === selectedVersion);
  const compared =
    selectedVersion !== null && selectedVersion !== currentNo
      ? (comparison.data ?? pickedRow ?? null)
      : null;
  const changes = compared
    ? diffLines(bodyLines(compared.body, compared.bodyFormat), bodyLines(body, bodyFormat))
    : [];
  const changeCount = changes.reduce((sum, block) => sum + block.lines.length, 0);

  async function uploadFile(file: File, signal?: AbortSignal) {
    if (!data) throw new Error('The document is not loaded.');
    // FIX3 item 5 (D1): the image is shown at once, so wait until the scan has made it servable;
    // before that its content answers 404 and the <img> stays broken until a reload.
    const id = await uploadProjectFile(
      api,
      organizationSlug,
      { projectId: data.projectId, file },
      // FIX4 item 1: wait until the file is usable (ready, or Not scanned under the owner's
      // policy), and stop when the dialog closes.
      signal ? { untilReady: true, signal } : { untilReady: true },
    );
    return {
      id,
      src: `/v1/organizations/${encodeURIComponent(organizationSlug)}/files/${encodeURIComponent(id)}/content`,
    };
  }

  const savedInstant = savedAt ?? (data ? Date.parse(data.updatedAt) : Number.NaN);
  const renaming = renameStatus === 'saving';
  const savedLabel =
    save.isPending || renaming
      ? tOr('DocumentEditorScreen.saving', 'Saving…')
      : conflict
        ? tOr('DocConflict.notSaved', 'Not saved · newer version')
        : renameStatus === 'conflict'
          ? tOr('DocumentEditorScreen.notSaved', 'Not saved')
          : Number.isNaN(savedInstant)
            ? ''
            : now - savedInstant < 60_000
              ? tOr('DocumentEditorScreen.savedJustNow', 'Saved · just now')
              : `${tOr('DocumentEditorScreen.savedAt', 'Saved ·')} ${formatClock(
                  new Date(savedInstant).toISOString(),
                  locale,
                )}`;

  const header = data ? (
    <>
      {conflict === 'banner' ? (
        <div className="tm-docconflict" role="alert">
          <p className="tm-docconflict__note">
            <span className="tm-docconflict__tag">{tOr('DocConflict.tag', 'Newer version')}</span>
            <span>
              {rtlLine(
                tOr(
                  'DocConflict.body',
                  'Someone saved a newer version. Reload to see it — your unsaved changes here are dropped.',
                ),
                locale,
              )}
            </span>
          </p>
          <div className="tm-docconflict__actions">
            <button
              type="button"
              className="tm-docpage__btn"
              data-tone="ink"
              onClick={() => void reload()}
            >
              {tOr('DocConflict.reload', 'Reload')}
            </button>
            <button type="button" className="tm-docpage__btn" onClick={() => setConflict('quiet')}>
              {tOr('DocConflict.keepEditing', 'Keep editing')}
            </button>
          </div>
        </div>
      ) : null}
      <DocTitleEditor
        api={api}
        organizationSlug={organizationSlug}
        document={data}
        onStatus={(status) => {
          setRenameStatus(status);
          if (status === 'saved') {
            setSavedAt(Date.now());
            setNow(Date.now());
          }
        }}
      />
      <p className="tm-docpage__meta">
        <span className="tm-docpage__pill">
          {published
            ? tOr('DocumentEditorScreen.published', 'Published')
            : tOr('DocumentEditorScreen.draft', 'Draft')}
        </span>
        <span>
          {rtlLine(
            `${projectName !== '' ? `${projectName} · ` : ''}${
              published
                ? tOr(
                    'DocumentEditorScreen.publishedNote',
                    "The project's client people can read this document",
                  )
                : // Live test 2026-10-31: "Only you can see this draft" was not true — the
                  // project's team can open it. Figma 446:35321 / 446:35464 say who can.
                  tOr(
                    'DocumentEditorScreen.draftNoteTeam',
                    'Your team can see this draft · clients only after you publish',
                  )
            }`,
            locale,
          )}
        </span>
      </p>
    </>
  ) : null;

  const footer = data ? (
    <>
      {body.trim() === '' ? (
        <Link className="tm-docpage__template" href={`/${organizationSlug}/docs/templates`}>
          {tOr('DocumentEditorScreen.fromTemplate', 'Or start from a template')}
        </Link>
      ) : null}

      {save.isError && !conflict ? (
        <InlineAlert
          tone="danger"
          title={tOr('DocumentEditorScreen.saveError', 'Could not save')}
          live
        >
          {describeError(save.error)}
        </InlineAlert>
      ) : null}
      {publish.isError ? (
        <InlineAlert
          tone="danger"
          title={tOr('DocumentEditorScreen.publishError', 'Could not publish')}
          live
        >
          {describeError(publish.error)}
        </InlineAlert>
      ) : null}

      {rows.length > 1 ? (
        <details className="tm-docpage__history">
          <summary>
            {tOr('DocumentEditorScreen.versionHistory', 'Version history')} · {rows.length}
          </summary>
          {/* DOC-03 Document history (Figma 145:224): the versions as cards, then Compare —
              "13 Aug 17:32 → Current", the added and removed lines, and Restore with its note. */}
          <div className="tm-docpage__versions">
            <ol aria-label={tOr('DocumentEditorScreen.savedVersionsAria', 'Saved versions')}>
              {ordered.map((version) => {
                const isCurrent = version.versionNo === currentNo;
                const who = authorOf(version.editedByUserId);
                return (
                  <li key={version.id}>
                    <button
                      type="button"
                      className="tm-docpage__version"
                      aria-pressed={isCurrent ? undefined : selectedVersion === version.versionNo}
                      aria-current={isCurrent ? 'true' : undefined}
                      disabled={isCurrent}
                      onClick={() => setSelectedVersion(version.versionNo)}
                    >
                      <span className="tm-docpage__version-when">
                        {isCurrent
                          ? `${tOr('DocumentEditorScreen.current', 'Current')} · ${formatClock(version.createdAt, locale)}`
                          : formatClock(version.createdAt, locale)}
                      </span>
                      <span className="tm-docpage__version-who">
                        {who !== ''
                          ? who
                          : `${tOr('DocumentEditorScreen.versionPrefix', 'v')}${version.versionNo}`}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
            {compared ? (
              <section
                className="tm-docpage__compare"
                aria-label={tOr('DocumentEditorScreen.compareAria', 'Compare versions')}
              >
                <p className="tm-docpage__compare-head">
                  <span>
                    {tOr('DocumentEditorScreen.compare', 'Compare')} ·{' '}
                    {formatClock(compared.createdAt, locale)} →{' '}
                    {tOr('DocumentEditorScreen.current', 'Current')}
                  </span>
                  <span>
                    {changeCount === 1
                      ? tOr('DocumentEditorScreen.oneChange', '1 change')
                      : tOr('DocumentEditorScreen.changes', '{count} changes').replace(
                          '{count}',
                          String(changeCount),
                        )}
                  </span>
                </p>
                {changes.length === 0 ? (
                  <p className="tm-docpage__compare-same">
                    {tOr(
                      'DocumentEditorScreen.noChanges',
                      'This version reads the same as the current one.',
                    )}
                  </p>
                ) : (
                  changes.map((block, index) => (
                    <div key={index} className="tm-docpage__change" data-kind={block.kind}>
                      <p className="tm-docpage__change-kind">
                        {block.kind === 'added'
                          ? tOr('DocumentEditorScreen.added', 'Added')
                          : tOr('DocumentEditorScreen.removed', 'Removed')}
                      </p>
                      {block.lines.map((line, at) =>
                        block.kind === 'removed' ? (
                          <del key={at}>{line}</del>
                        ) : (
                          <ins key={at}>{line}</ins>
                        ),
                      )}
                    </div>
                  ))
                )}
                <div className="tm-docpage__restore">
                  <button
                    type="button"
                    className="tm-docpage__btn"
                    disabled={restore.isPending}
                    onClick={() => restore.mutate(compared.versionNo)}
                  >
                    {tOr('DocumentEditorScreen.restoreVersion', 'Restore {when} version').replace(
                      '{when}',
                      formatClock(compared.createdAt, locale),
                    )}
                  </button>
                  <p>
                    {tOr(
                      'DocumentEditorScreen.restoreNote',
                      'Restoring creates a new version. Nothing is overwritten.',
                    )}
                  </p>
                </div>
              </section>
            ) : null}
          </div>
        </details>
      ) : null}
    </>
  ) : null;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="docs"
      title={data ? data.title : tOr('DocumentEditorScreen.editFallback', 'Document')}
      contextRail={
        <DocsSidebar
          api={api}
          organizationSlug={organizationSlug}
          activeDocumentId={documentId}
          {...(data ? { projectId: data.projectId } : {})}
        />
      }
    >
      <div className="tm-docpage">
        <div className="tm-docpage__bar">
          <nav aria-label={tOr('DocumentEditorScreen.breadcrumbAria', 'Breadcrumb')}>
            <ol className="tm-docpage__crumbs">
              <li>
                <Link href={`/${organizationSlug}/docs`}>
                  {tOr('DocumentEditorScreen.crumbDocs', 'Docs')}
                </Link>
              </li>
              {projectName !== '' ? (
                <>
                  <li aria-hidden="true">/</li>
                  <li>{projectName}</li>
                </>
              ) : null}
            </ol>
          </nav>
          <div className="tm-docpage__bar-end">
            {collab ? <DocCollabBar peers={live.peers} status={live.status} /> : null}
            {!collab && others.length > 0 ? (
              <ul className="tm-docpresence" aria-label={tOr('DocPresence.aria', 'Also editing')}>
                {others.map((editor) => (
                  <li key={editor.userId} className="tm-docpresence__chip">
                    <span className="tm-doced__orb" aria-hidden="true">
                      {initialsFor(editor.name)}
                    </span>
                    <span dir="auto">
                      {tOr('DocPresence.editing', '{name} is editing').replace(
                        '{name}',
                        editor.name,
                      )}
                    </span>
                    <span className="tm-docpresence__live">
                      {tOr('DocPresence.live', 'Live now')}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <span className="tm-docpage__saved tm-doctitle__saving" role="status">
              {renaming ? <span className="tm-doctitle__spinner" aria-hidden="true" /> : null}
              {savedLabel}
            </span>
            {data ? (
              <DocumentLifecycleActions
                organizationSlug={organizationSlug}
                client={api}
                document={data}
              />
            ) : null}
            {/* Live test 2026-10-31: Share opens the share dialog (Figma 446:35464). */}
            <button
              type="button"
              className="tm-docpage__btn"
              aria-haspopup="dialog"
              onClick={() => setShareOpen(true)}
            >
              {tOr('DocumentEditorScreen.share', 'Share')}
            </button>
            {sharing.data?.canPublish && !published ? (
              <button
                type="button"
                className="tm-docpage__btn"
                data-tone="ink"
                disabled={publish.isPending}
                onClick={() => publish.mutate()}
              >
                {tOr('DocumentEditorScreen.publish', 'Publish')}
              </button>
            ) : null}
          </div>
        </div>

        {document.isError ? (
          <InlineAlert
            tone="danger"
            title={tOr('DocumentEditorScreen.loadError', 'Could not load this document')}
            live
          >
            {describeError(document.error)}
          </InlineAlert>
        ) : null}
        {document.isPending ? (
          <LoadingRegion label={tOr('DocumentEditorScreen.loading', 'Loading the document')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {data && !collabJoin.isPending && restored !== undefined ? (
          <div
            onFocus={() => setFocused(true)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setFocused(false);
              }
            }}
          >
            <DocEditor
              key={collab ? `collab-${editorKey}-${collab.version}` : editorKey}
              value={collab?.baseHtml ?? restored ?? stored}
              format={collab?.baseHtml || restored ? 'html' : format}
              {...(collab
                ? { collab: { version: collab.baseVersion }, onEditor: setCollabEditor }
                : {})}
              onChange={setDraft}
              onUploadFile={uploadFile}
              api={api}
              organizationSlug={organizationSlug}
              dir={isArabic(locale) ? 'rtl' : 'ltr'}
              header={
                collab?.role === 'viewer' ? (
                  <>
                    <DocViewOnlyBanner />
                    {header}
                  </>
                ) : (
                  header
                )
              }
              footer={footer}
            />
          </div>
        ) : null}
        {shareOpen && data ? (
          <DocShareDialog
            organizationSlug={organizationSlug}
            documentId={documentId}
            documentTitle={data.title}
            projectName={projectName}
            sharing={sharing.data}
            onClose={() => setShareOpen(false)}
          />
        ) : null}
      </div>
    </AppShell>
  );
}

/** A body as lines of text for Compare: HTML block by block, Markdown as written. */
function bodyLines(body: string, format: DocumentBodyFormat | undefined): string {
  if (format !== 'html' || typeof DOMParser === 'undefined') return body;
  const parsed = new DOMParser().parseFromString(body, 'text/html');
  return Array.from(parsed.body.querySelectorAll('h1,h2,h3,p,li,pre,td,th'))
    .filter((block) => !block.querySelector('p'))
    .map((block) => block.textContent ?? '')
    .join('\n');
}

/** "10:51" today, else "16 Oct, 10:51" — Latin digits in Arabic. */
function formatClock(iso: string, locale: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const tag = tagFor(locale);
  const sameDay = new Date().toDateString() === at.toDateString();
  return new Intl.DateTimeFormat(tag, {
    ...(sameDay ? {} : { day: 'numeric', month: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
}

/** A save failure worth trying again: no answer at all, a timeout, rate limit or a server error. */
function isTransientSaveError(error: unknown): boolean {
  if (error instanceof ApiRequestError) return isTransientStatus(error.status);
  return error instanceof TypeError;
}
