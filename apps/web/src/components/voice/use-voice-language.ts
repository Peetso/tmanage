'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '../../lib/api/client';
import {
  displayPreferencesKey,
  getDisplayPreferences,
  updateDisplayPreferences,
  withDictationLanguage,
} from '../../lib/api/display-preferences';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import {
  appLanguageTag,
  dictationBlock,
  isDesktopApp,
  isDictationTag,
  type DictationBlock,
} from '../ai-chat/dictation-language';
import { useDictation, type Dictation } from './useDictation';

/**
 * The member's dictation language: one choice for every box that listens (the AI chat, a work's
 * name, steps, comments, a team or stage name). It is the member's own `dictationLanguage`
 * display preference, so it follows them to every browser; until they pick one it is the app
 * language. A new pick shows at once while it saves.
 */
export interface VoiceLanguage {
  /** The BCP-47 tag dictation listens in. */
  readonly tag: string;
  /** The app language's tag, marked "App language" in the menu. */
  readonly appTag: string;
  readonly choose: (tag: string) => void;
  /** The desktop app has no speech service; `null` until mounted. */
  readonly desktopApp: boolean | null;
}

export function useVoiceLanguage(api: ApiClient, organizationSlug: string): VoiceLanguage {
  const locale = useActiveLocale();
  const queries = useQueryClient();
  const appTag = appLanguageTag(locale);
  const preferences = useQuery({
    queryKey: displayPreferencesKey(organizationSlug),
    queryFn: () => getDisplayPreferences(api, organizationSlug),
  });
  const [chosen, setChosen] = useState<string | null>(null);
  const saved = isDictationTag(preferences.data?.dictationLanguage)
    ? (preferences.data?.dictationLanguage ?? null)
    : null;
  const save = useMutation({
    mutationFn: async (tag: string) => {
      if (!isDictationTag(tag)) throw new Error('not a dictation language');
      const current = await getDisplayPreferences(api, organizationSlug);
      return updateDisplayPreferences(api, organizationSlug, withDictationLanguage(current, tag));
    },
    onSuccess: (next) => queries.setQueryData(displayPreferencesKey(organizationSlug), next),
  });
  // Known only after mount, so the server render and the first client render agree.
  const [desktopApp, setDesktopApp] = useState<boolean | null>(null);
  useEffect(() => setDesktopApp(isDesktopApp()), []);

  return {
    tag: chosen ?? saved ?? appTag,
    appTag,
    choose: (tag: string) => {
      setChosen(tag);
      save.mutate(tag);
    },
    desktopApp,
  };
}

/** One listening text box: the dictation, its language and why it cannot run (if it cannot). */
export interface VoiceInput {
  readonly dictation: Dictation;
  readonly language: VoiceLanguage;
  readonly block: DictationBlock;
}

export function useVoiceInput({
  api,
  organizationSlug,
  value,
  onChange,
}: {
  api: ApiClient;
  organizationSlug: string;
  value: string;
  onChange: (next: string) => void;
}): VoiceInput {
  const language = useVoiceLanguage(api, organizationSlug);
  const heard = useDictation({ value, onChange, lang: language.tag });
  const dictation = language.desktopApp ? { ...heard, supported: false } : heard;
  const block: DictationBlock =
    language.desktopApp === null ? null : dictationBlock(heard.supported, language.desktopApp);
  return { dictation, language, block };
}
