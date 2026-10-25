'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { DocsSidebar } from '../docs/DocsSidebar';
import { DocTitleEditor, type RenameStatus } from '../docs/DocTitleEditor';
import '../docs/docs-shell.css';
import {
  DOC_TOOL_EDITS,
  applyDocEdit,
  isBlankBody,
  rtlLine,
  tagFor,
  type DocToolId,
} from '../docs/doc-markdown';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  getDocument,
  getDocumentSharing,
  getDocumentVersion,
  listDocumentVersions,
  restoreDocumentVersion,
  saveDocumentVersion,
  setDocumentAudience,
} from '../../lib/api/documents';
import { listProjects } from '../../lib/api/projects';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';

export interface DocumentEditorScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** The document being edited — its id arrives in the route path. */
  documentId: string;
  client?: ApiClient;
  /** How long typing must pause before the draft is saved. Tests pass a short one. */
  autosaveDelayMs?: number;
}

/** The toolbar of 383:3806, in its order. `words` marks a label drawn in the UI font in Arabic. */
const TOOLS: readonly {
  readonly id: DocToolId;
  readonly key: string;
  readonly english: string;
  readonly glyph?: string;
  readonly words?: boolean;
}[] = [
  { id: 'h1', key: 'DocumentEditorScreen.toolH1', english: 'H1' },
  { id: 'h2', key: 'DocumentEditorScreen.toolH2', english: 'H2' },
  { id: 'bold', key: 'DocumentEditorScreen.toolBold', english: 'B' },
  { id: 'italic', key: 'DocumentEditorScreen.toolItalic', english: 'I' },
  { id: 'list', key: 'DocumentEditorScreen.toolList', english: 'List', glyph: '•', words: true },
  {
    id: 'checklist',
    key: 'DocumentEditorScreen.toolChecklist',
    english: 'Checklist',
    glyph: '☐',
    words: true,
  },
  { id: 'link', key: 'DocumentEditorScreen.toolLink', english: 'Link', glyph: '↗', words: true },
];

/**
 * **DOC-02 editor** — the blank new doc of Figma 383:3806 / 383:4019 (A15).
 *
 * The Slack-like docs column on the start side; a top bar with the breadcrumb ("Docs / <project>"),
 * the save state ("Saved · just now"), Share (copies the document's link) and Publish (the client
 * audience, offered only when the API says the caller may publish); the toolbar (markdown edits on
 * the body at the selection); then the sheet: the title, the Draft pill with who can see it, the
 * body with its placeholder and — while the body is empty — "Or start from a template".
 *
 * **Every pause is a save.** Typing stops for {@link DocumentEditorScreenProps.autosaveDelayMs} and
 * the body is saved as a new immutable version (the API appends a snapshot); restore stays
 * forward-append. Once a document has more than one version, its history sits folded under the
 * sheet, so the blank document reads exactly as designed.
 */
export function DocumentEditorScreen({
  organizationSlug,
  organizationName,
  documentId,
  client,
  autosaveDelayMs = 1200,
}: DocumentEditorScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const tOr = useTOr();
  const locale = useActiveLocale();
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

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

  // `null` = not edited yet: the body shows the document's current text (blank shows as empty).
  const [draft, setDraft] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  // F2: the title rename's own save state, shown in the same place as the body's.
  const [renameStatus, setRenameStatus] = useState<RenameStatus>('idle');
  // Keep the newest `now` when the document (re)loads, so a fresh document reads "just now".
  const loadedAt = document.dataUpdatedAt;
  useEffect(() => {
    if (loadedAt > 0) setNow(Date.now());
  }, [loadedAt]);

  const data = document.data;
  const stored = data && !isBlankBody(data.body) ? data.body : '';
  const body = draft ?? stored;

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['document', organizationSlug, documentId] }),
      queryClient.invalidateQueries({
        queryKey: ['document-versions', organizationSlug, documentId],
      }),
    ]);
  };

  const save = useMutation({
    mutationFn: (text: string) => saveDocumentVersion(api, organizationSlug, documentId, text),
    onSuccess: async () => {
      setSavedAt(Date.now());
      setNow(Date.now());
      await invalidate();
    },
  });

  const restore = useMutation({
    mutationFn: (versionNo: number) =>
      restoreDocumentVersion(api, organizationSlug, documentId, versionNo),
    onSuccess: async () => {
      setDraft(null);
      setSelectedVersion(null);
      setSavedAt(Date.now());
      await invalidate();
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

  // Autosave: a pause in typing saves the draft once, if it differs from what is stored.
  const { mutate: saveNow } = save;
  useEffect(() => {
    if (draft === null || draft.trim() === '' || draft === stored) return undefined;
    const timer = setTimeout(() => saveNow(draft), autosaveDelayMs);
    return () => clearTimeout(timer);
  }, [draft, stored, autosaveDelayMs, saveNow]);

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

  function applyTool(id: DocToolId) {
    const control = bodyRef.current;
    const start = control?.selectionStart ?? body.length;
    const end = control?.selectionEnd ?? body.length;
    const result = applyDocEdit(
      body,
      start,
      end,
      DOC_TOOL_EDITS[id],
      tOr('DocumentEditorScreen.toolPlaceholder', 'text'),
    );
    setDraft(result.text);
    requestAnimationFrame(() => {
      control?.focus();
      control?.setSelectionRange(result.caret, result.caret);
    });
  }

  async function share() {
    const href =
      typeof window === 'undefined'
        ? ''
        : `${window.location.origin}/${organizationSlug}/docs/${documentId}`;
    try {
      await navigator.clipboard?.writeText(href);
    } catch {
      // Clipboard refused (an insecure context); the link is still the page's own address.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const savedInstant = savedAt ?? (data ? Date.parse(data.updatedAt) : Number.NaN);
  const renaming = renameStatus === 'saving';
  const savedLabel =
    save.isPending || renaming
      ? tOr('DocumentEditorScreen.saving', 'Saving…')
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
            <span className="tm-docpage__saved tm-doctitle__saving" role="status">
              {renaming ? <span className="tm-doctitle__spinner" aria-hidden="true" /> : null}
              {savedLabel}
            </span>
            <button type="button" className="tm-docpage__btn" onClick={() => void share()}>
              {copied
                ? tOr('DocumentEditorScreen.linkCopied', 'Link copied')
                : tOr('DocumentEditorScreen.share', 'Share')}
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

        <div
          className="tm-docpage__tools"
          role="toolbar"
          aria-label={tOr('DocumentEditorScreen.toolbarAria', 'Formatting')}
        >
          {TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className="tm-docpage__tool"
              data-words={tool.words ? 'true' : 'false'}
              onClick={() => applyTool(tool.id)}
            >
              {tool.glyph ? <span aria-hidden="true">{tool.glyph}</span> : null}
              {tOr(tool.key, tool.english)}
            </button>
          ))}
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

        {data ? (
          <section className="tm-docpage__sheet" aria-labelledby="tm-doc-title">
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
                      : tOr(
                          'DocumentEditorScreen.draftNote',
                          'Only you can see this draft until you share it',
                        )
                  }`,
                  locale,
                )}
              </span>
            </p>
            <label className="tm-visually-hidden" htmlFor="tm-doc-body">
              {tOr('DocumentEditorScreen.documentBody', 'Document body')}
            </label>
            <textarea
              id="tm-doc-body"
              ref={bodyRef}
              name="body"
              className="tm-docpage__body"
              value={body}
              placeholder={tOr(
                'DocumentEditorScreen.placeholder',
                'Start writing, or type / for headings, lists and checklists.',
              )}
              onChange={(event) => setDraft(event.target.value)}
            />
            {body.trim() === '' ? (
              <Link className="tm-docpage__template" href={`/${organizationSlug}/docs/templates`}>
                {tOr('DocumentEditorScreen.fromTemplate', 'Or start from a template')}
              </Link>
            ) : null}

            {save.isError ? (
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
                <ol aria-label={tOr('DocumentEditorScreen.savedVersionsAria', 'Saved versions')}>
                  {rows.map((version) => (
                    <li key={version.id}>
                      <span>
                        {tOr('DocumentEditorScreen.versionPrefix', 'v')}
                        {version.versionNo} · {formatClock(version.createdAt, locale)}
                      </span>
                      <button
                        type="button"
                        className="tm-docpage__tool"
                        aria-pressed={selectedVersion === version.versionNo}
                        onClick={() => setSelectedVersion(version.versionNo)}
                      >
                        {tOr('DocumentEditorScreen.compare', 'Compare')}
                      </button>
                      <button
                        type="button"
                        className="tm-docpage__tool"
                        disabled={restore.isPending}
                        onClick={() => restore.mutate(version.versionNo)}
                      >
                        {tOr('DocumentEditorScreen.restore', 'Restore')}
                      </button>
                    </li>
                  ))}
                </ol>
                {comparison.data ? <pre>{comparison.data.body}</pre> : null}
              </details>
            ) : null}
          </section>
        ) : null}
      </div>
    </AppShell>
  );
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

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
