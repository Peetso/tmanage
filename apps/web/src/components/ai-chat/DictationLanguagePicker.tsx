'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import {
  InfoButton,
  MOTION_DELAY_TOOLTIP_MS,
  Radio,
  RadioGroup,
  SearchField,
  StateCapsule,
  Tooltip,
} from '@tmanage/ui';
import {
  DICTATION_GROUPS,
  DICTATION_LANGUAGES,
  filterLanguages,
  languageNameKey,
  languageShortKey,
  type DictationBlock,
  type DictationGroup,
} from './dictation-language';
import { CloseIcon } from './icons';
import { useAiText, type AiTextKey } from './use-ai-text';

/** A full name longer than this takes the short form on a phone (Fable N1). */
const PHONE_SHORT_AFTER = 18;

const GROUP_KEY: Readonly<Record<DictationGroup, AiTextKey>> = {
  english: 'AiChat.dictation.group.english',
  arabic: 'AiChat.dictation.group.arabic',
  other: 'AiChat.dictation.group.other',
};

export interface DictationLanguagePickerProps {
  /** The chosen BCP-47 tag (the app language until the member picks one). */
  readonly value: string;
  /** The app-language tag, marked "App language" in the list. */
  readonly appTag: string;
  readonly onChange: (tag: string) => void;
  /** Why dictation cannot run here; the chip stays focusable and says why (`aria-disabled`). */
  readonly blocked: DictationBlock;
  /** Locked while the microphone listens. */
  readonly locked: boolean;
  /**
   * Where the menu opens: `above` the chip (the AI composer at the foot of its panel, the
   * default) or `below` it (a name field at the top of a page or dialog, Figma `935:97514`).
   */
  readonly placement?: 'above' | 'below';
  /**
   * What the chip says: the full name with its region ("English (US)", the AI composer), or the
   * language alone ("English"), as Figma `Control/Voice` draws it beside a name or a step; the
   * region then shows only in the menu and in the chip's accessible name (Fable WORK-BUILD 10).
   */
  readonly chipName?: 'full' | 'language';
}

function isPhone(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia?.('(max-width: 767px)').matches === true
  );
}

/**
 * The dictation language chip and its searchable menu (Figma chip set 878:976, menu 873:1042,
 * search 873:1219, no match 873:1260, chosen 873:1285, Firefox 873:1312, desktop app 873:1339;
 * phone sheet 874:1179). Kit parts only: `SearchField`, `RadioGroup`/`Radio`, `InfoButton`,
 * `Tooltip`, `StateCapsule` (Fable build rule 1).
 *
 * Keyboard (build rule 2): the chip opens on Enter, Space or Down; typing filters; Down moves into
 * the list and Up/Down move through it; Enter or Space chooses and closes; Escape closes; focus
 * returns to the chip. The search field takes focus on open on desktop, not on a phone.
 */
export function DictationLanguagePicker({
  value,
  appTag,
  onChange,
  blocked,
  locked,
  placement = 'above',
  chipName = 'full',
}: DictationLanguagePickerProps) {
  const text = useAiText();
  const { t } = text;
  const menuId = useId();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(value);
  const chip = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLSpanElement>(null);

  const name = (tag: string) => t(languageNameKey(tag) as AiTextKey);
  const current = DICTATION_LANGUAGES.find((language) => language.tag === value);
  const fullName = name(value);
  const shortName = current ? t(languageShortKey(current.group, value) as AiTextKey) : fullName;
  const disabled = blocked !== null || locked;

  // Every name a member might type: the one on screen, plus the English and Arabic names.
  const names = useMemo(() => {
    const english = displayNames('en');
    const arabic = displayNames('ar');
    return new Map(
      DICTATION_LANGUAGES.map((language) => [
        language.tag,
        [
          t(languageNameKey(language.tag) as AiTextKey),
          english?.of(language.tag) ?? '',
          arabic?.of(language.tag) ?? '',
        ],
      ]),
    );
  }, [t]);
  const matches = filterLanguages(query, names);

  function close(returnFocus: boolean) {
    setOpen(false);
    setQuery('');
    if (returnFocus) chip.current?.focus();
  }

  function choose(tag: string) {
    onChange(tag);
    close(true);
  }

  function openMenu() {
    if (disabled) return;
    setPending(value);
    setOpen(true);
  }

  // On open: the chosen language in view; focus in the search (desktop) or on the choice (phone).
  useEffect(() => {
    if (!open) return;
    const checked = menu.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked');
    checked?.scrollIntoView?.({ block: 'nearest' });
    if (isPhone()) checked?.focus();
    else searchBox.current?.querySelector('input')?.focus();
  }, [open]);

  // A press outside closes the menu without choosing.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menu.current?.contains(target) || chip.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  function onChipKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openMenu();
    }
  }

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      // The panel closes on Escape too; this one belongs to the menu.
      event.stopPropagation();
      event.preventDefault();
      close(true);
    }
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const radios = menu.current?.querySelectorAll<HTMLInputElement>('input[type="radio"]');
      const target =
        [...(radios ?? [])].find((radio) => radio.checked) ?? radios?.item(0) ?? undefined;
      target?.focus();
    } else if (event.key === 'Enter') {
      // Never submits the message box around it: Enter picks the first match.
      event.preventDefault();
      const first = matches[0];
      if (first) choose(first.tag);
    }
  }

  function onRadioKey(event: KeyboardEvent<HTMLInputElement>, tag: string) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(tag);
    }
  }

  function onRadioClick(event: MouseEvent<HTMLInputElement>, tag: string) {
    // Arrow keys also fire a click (detail 0) as they move the choice; only a pointer chooses.
    if (event.detail > 0) choose(tag);
  }

  const reason =
    blocked === 'desktop-app'
      ? t('AiChat.dictation.blockedDesktop')
      : blocked === 'browser'
        ? t('AiChat.dictation.blockedBrowser')
        : null;
  const accessibleName = t('AiChat.dictation.chipLabel', { language: fullName });
  const languageOnly = chipName === 'language';
  const useShort = !languageOnly && fullName.length > PHONE_SHORT_AFTER && shortName !== fullName;

  const chipButton = (
    <button
      ref={chip}
      type="button"
      className="tm-aic-dict__chip"
      aria-label={accessibleName}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      aria-disabled={disabled || undefined}
      data-open={open || undefined}
      onClick={() => (open ? close(true) : openMenu())}
      onKeyDown={onChipKey}
    >
      <span className={useShort ? 'tm-aic-dict__full' : undefined}>
        {languageOnly ? shortName : fullName}
      </span>
      {useShort ? <span className="tm-aic-dict__short">{shortName}</span> : null}
      <svg
        className="tm-aic-dict__chevron"
        viewBox="0 0 16 16"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d={open ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'} />
      </svg>
    </button>
  );

  return (
    <span className="tm-aic-dict">
      {reason !== null ? (
        <Tooltip content={reason} delayMs={MOTION_DELAY_TOOLTIP_MS} placement="top">
          {chipButton}
        </Tooltip>
      ) : useShort ? (
        <Tooltip content={fullName} delayMs={MOTION_DELAY_TOOLTIP_MS} placement="top">
          {chipButton}
        </Tooltip>
      ) : (
        chipButton
      )}

      {open ? (
        // The menu keeps Escape to itself, so the panel around it stays open.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
        <div
          ref={menu}
          id={menuId}
          className="tm-aic-dict__menu"
          data-placement={placement}
          role="dialog"
          aria-labelledby={titleId}
          onKeyDown={onMenuKey}
        >
          <div className="tm-aic-dict__head">
            <h3 id={titleId} className="tm-aic-dict__title">
              {t('AiChat.dictation.title')}
            </h3>
            <span className="tm-aic-dict__info">
              <InfoButton
                title={t('AiChat.dictation.title')}
                label={t('AiChat.dictation.infoLabel')}
              >
                {t('AiChat.dictation.info')}
              </InfoButton>
            </span>
            <span className="tm-aic__spacer" />
            <button
              type="button"
              className="tm-aic__icon tm-aic-dict__close"
              aria-label={t('AiChat.dictation.close')}
              onClick={() => close(true)}
            >
              <CloseIcon />
            </button>
          </div>
          <span ref={searchBox} className="tm-aic-dict__search-box">
            <SearchField
              label={t('AiChat.dictation.search')}
              placeholder={t('AiChat.dictation.search')}
              className="tm-aic-dict__search"
              autoComplete="off"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={onSearchKey}
            />
          </span>
          <div className="tm-aic-dict__scroll">
            {matches.length === 0 ? (
              <div className="tm-aic-dict__none" role="status">
                <p>{t('AiChat.dictation.noMatch', { query: query.trim() })}</p>
                <p className="tm-aic-note">{t('AiChat.dictation.noMatchHint')}</p>
              </div>
            ) : (
              DICTATION_GROUPS.map((group) => {
                const rows = matches.filter((language) => language.group === group);
                if (rows.length === 0) return null;
                return (
                  <RadioGroup
                    key={group}
                    legend={t(GROUP_KEY[group])}
                    name={`${menuId}-language`}
                    className="tm-aic-dict__group"
                  >
                    {rows.map((language) => (
                      <Radio
                        key={language.tag}
                        className="tm-aic-dict__option"
                        label={
                          <>
                            <span>{name(language.tag)}</span>
                            {language.tag === appTag ? (
                              <StateCapsule className="tm-aic-dict__app">
                                {t('AiChat.dictation.appLanguage')}
                              </StateCapsule>
                            ) : null}
                          </>
                        }
                        lang={language.tag}
                        checked={language.tag === pending}
                        onChange={() => setPending(language.tag)}
                        onKeyDown={(event) => onRadioKey(event, language.tag)}
                        onClick={(event) => onRadioClick(event, language.tag)}
                      />
                    ))}
                  </RadioGroup>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </span>
  );
}

function displayNames(locale: string): Intl.DisplayNames | null {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' });
  } catch {
    return null;
  }
}
