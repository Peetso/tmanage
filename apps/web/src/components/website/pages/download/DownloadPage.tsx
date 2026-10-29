'use client';

import { useEffect, useState } from 'react';
import { Badge, Button, InlineAlert, StateCapsule } from '@tmanage/ui';
import Link from '../../WebLink';
import { useT } from '../../../../lib/i18n/use-t';
import type { MessageKey } from '../../../../lib/i18n/t';
import { DESKTOP_INSTALLER_HREF } from '../../../../lib/desktop-download';
import { DESKTOP_INSTALLER_SHA256_HREF, parseSha256 } from './installer-checksum';
import './download.css';

/** The `DownloadPage.*` keys ship as a wave fragment; the cast holds until they reach `en.json`. */
const key = (name: string) => `DownloadPage.${name}` as MessageKey;

const INSTALLER_NAME = 'TManage-Setup.exe';
const HASH_COMMAND = `Get-FileHash .\\${INSTALLER_NAME}`;

/** Reads the deploy-time checksum; `undefined` until it arrives or when it is not served. */
function useInstallerSha256(): string | undefined {
  const [sha, setSha] = useState<string | undefined>();
  useEffect(() => {
    let live = true;
    fetch(DESKTOP_INSTALLER_SHA256_HREF, { cache: 'no-store' })
      .then((response) => (response.ok ? response.text() : ''))
      .then((text) => {
        if (live) setSha(parseSha256(text));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return sha;
}

function ChecksumBlock({ sha }: { sha: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <>
      <p className="tm-dlp__label">{t(key('shaLabel'))}</p>
      {/* A hex value and a command always read left to right, also on the Arabic page. */}
      <div className="tm-dlp__sha" dir="ltr">
        <code className="tm-dlp__sha-value">{sha}</code>
        <Button
          tone="outline"
          className="tm-dlp__button"
          onClick={() => {
            void navigator.clipboard?.writeText(sha).then(() => setCopied(true));
          }}
        >
          {t(key(copied ? 'copied' : 'copy'))}
        </Button>
      </div>
    </>
  );
}

/**
 * PUB-03 · Download (`/download`, `/ar/download`) — Figma 443:20300 EN / 443:20400 AR. The
 * Windows card, the Mac card and the phone card, under the unsigned-beta notice, then the three
 * "how to open" steps. The installer and its checksum are plain anchors and fetches: the
 * one-process server answers `/downloads/*`, so they are never client-routed or `/ar`-prefixed.
 * Logical properties only, so the Arabic page mirrors without a second stylesheet.
 */
export function DownloadPage() {
  const t = useT();
  const sha = useInstallerSha256();
  return (
    <section className="tm-dlp" aria-labelledby="dlp-title">
      <div className="tm-web-container tm-dlp__stack">
        <header className="tm-dlp__intro">
          <p className="tm-dlp__eyebrow">{t(key('eyebrow'))}</p>
          <h1 id="dlp-title" className="tm-dlp__title">
            {t(key('title'))}
          </h1>
          <p className="tm-dlp__lead">{t(key('lead'))}</p>
        </header>

        <InlineAlert tone="warning" title={t(key('betaTitle'))} className="tm-dlp__alert">
          {t(key('betaBody'))}
        </InlineAlert>

        <div className="tm-dlp__platforms">
          <article className="tm-dlp__card" aria-labelledby="dlp-windows">
            <div className="tm-dlp__card-head">
              <h2 id="dlp-windows" className="tm-dlp__card-title">
                {t(key('windowsTitle'))}
              </h2>
              <Badge>{t(key('betaBadge'))}</Badge>
            </div>
            <p className="tm-dlp__body">{t(key('windowsBody'))}</p>
            <p className="tm-dlp__file" dir="ltr">
              {INSTALLER_NAME}
            </p>
            <a
              href={DESKTOP_INSTALLER_HREF}
              download
              className="tm-button tm-button--ink tm-button--default tm-dlp__button"
            >
              {t(key('windowsDownload'))}
            </a>
            {sha === undefined ? null : <ChecksumBlock sha={sha} />}
            <p className="tm-dlp__aside">{t(key('storeSoon'))}</p>
          </article>

          <article className="tm-dlp__card" aria-labelledby="dlp-mac">
            <div className="tm-dlp__card-head">
              <h2 id="dlp-mac" className="tm-dlp__card-title">
                {t(key('macTitle'))}
              </h2>
              <StateCapsule state="future">{t(key('macLater'))}</StateCapsule>
            </div>
            <p className="tm-dlp__body">{t(key('macBody'))}</p>
            <Link
              href="/sign-in"
              className="tm-button tm-button--outline tm-button--default tm-dlp__button"
            >
              {t(key('macOpen'))}
            </Link>
          </article>

          <article className="tm-dlp__card" aria-labelledby="dlp-phone">
            <h2 id="dlp-phone" className="tm-dlp__card-title">
              {t(key('phoneTitle'))}
            </h2>
            <p className="tm-dlp__body">{t(key('phoneBody'))}</p>
            <p className="tm-dlp__step-chip">{t(key('phoneIphone'))}</p>
            <p className="tm-dlp__step-chip">{t(key('phoneAndroid'))}</p>
          </article>
        </div>

        <section className="tm-dlp__card tm-dlp__howto" aria-labelledby="dlp-howto">
          <h2 id="dlp-howto" className="tm-dlp__howto-title">
            {t(key('howTitle'))}
          </h2>
          <ol className="tm-dlp__steps">
            <li className="tm-dlp__step">
              <span className="tm-dlp__step-label">{t(key('step1Label'))}</span>
              <p className="tm-dlp__step-text">{t(key('step1'))}</p>
            </li>
            <li className="tm-dlp__step">
              <span className="tm-dlp__step-label">{t(key('step2Label'))}</span>
              <p className="tm-dlp__step-text">{t(key('step2'))}</p>
              <code className="tm-dlp__command" dir="ltr">
                {HASH_COMMAND}
              </code>
            </li>
            <li className="tm-dlp__step">
              <span className="tm-dlp__step-label">{t(key('step3Label'))}</span>
              <p className="tm-dlp__step-text">{t(key('step3'))}</p>
            </li>
          </ol>
          <p className="tm-dlp__aside">{t(key('footnote'))}</p>
        </section>
      </div>
    </section>
  );
}
