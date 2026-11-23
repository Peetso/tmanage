'use client';

import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../../lib/api/client';
import { VoiceControl } from '../../voice/VoiceControl';
import { useVoiceInput } from '../../voice/use-voice-language';
import { useA6T } from '../DueDatePicker';

/**
 * The work's name in the page title, renamed in place (Figma `933:95423`): a click on the name
 * (or Enter on it) turns it into a box; Enter or leaving the box saves, Escape puts it back. The
 * microphone and the language chip beside it (`Control/Voice`) dictate a new name in any of the
 * member's languages, straight into the same box.
 */
export function WorkTitle({
  api,
  organizationSlug,
  title,
  readOnly = false,
  saving = false,
  onRename,
}: {
  api: ApiClient;
  organizationSlug: string;
  title: string;
  readOnly?: boolean;
  saving?: boolean;
  onRename: (title: string) => void;
}) {
  const t = useA6T();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const box = useRef<HTMLInputElement>(null);
  const voice = useVoiceInput({ api, organizationSlug, value: draft, onChange: setDraft });
  const listening =
    voice.dictation.status === 'listening' || voice.dictation.status === 'processing';

  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);

  // Speaking a name opens the box, so the words appear where they will be saved.
  useEffect(() => {
    if (listening && !editing) {
      setDraft('');
      setEditing(true);
    }
  }, [listening, editing]);

  useEffect(() => {
    if (editing) box.current?.focus();
  }, [editing]);

  function save() {
    const next = draft.trim();
    setEditing(false);
    if (next !== '' && next !== title) onRename(next.slice(0, 300));
    else setDraft(title);
  }

  return (
    <span className="tm-wk-title">
      {editing ? (
        <input
          ref={box}
          className="tm-wk-title__input"
          value={draft}
          dir="auto"
          maxLength={300}
          aria-label={t('WorkPage.renameLabel')}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (!listening) save();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') save();
            if (event.key === 'Escape') {
              setDraft(title);
              setEditing(false);
            }
          }}
        />
      ) : readOnly ? (
        <span className="tm-wk-title__text">
          <bdi>{title}</bdi>
        </span>
      ) : (
        <button
          type="button"
          className="tm-wk-title__text"
          title={t('WorkPage.renameHint')}
          aria-label={t('WorkPage.renameButton', { title })}
          aria-busy={saving || undefined}
          onClick={() => setEditing(true)}
        >
          <bdi>{title}</bdi>
        </button>
      )}
      {readOnly ? null : <VoiceControl input={voice} />}
    </span>
  );
}
