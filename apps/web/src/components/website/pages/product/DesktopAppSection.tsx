'use client';

import { useT } from '../../../../lib/i18n/use-t';
import type { MessageKey } from '../../../../lib/i18n/t';
import {
  DESKTOP_INSTALLER_HREF,
  DESKTOP_INSTALLER_SIZE_MB,
} from '../../../../lib/desktop-download';
import './desktop-app.css';

/** The `DesktopApp.*` keys ship as a wave fragment; the cast holds until they reach `en.json`. */
const key = (name: string) => `DesktopApp.${name}` as MessageKey;

/** The TManage mark as drawn in the desktop window (Figma 412:6731), in the lime brand colour. */
function DesktopMark() {
  return (
    <svg
      className="tm-dl-window__mark"
      viewBox="0 0 200 151.992"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M124.319 46.1216H144.654C151.782 45.7023 158.491 44.0252 165.199 41.9287C184.277 35.6394 198.533 20.5451 200 0H54.088C46.7505 0 40.2516 1.46751 33.7526 3.56394C16.1426 9.22432 5.03145 24.9476 2.93501 43.1866L0 70.6499C2.93501 61.2159 10.6918 55.1363 20.1258 51.3627C29.5597 47.5891 40.2516 46.1216 50.9434 46.1216H124.319Z" />
      <path d="M129.769 65.4088C123.48 67.9245 119.287 73.3753 116.562 79.8742C113.627 87.2117 112.579 94.5493 112.788 102.725V111.111C111.95 119.706 111.321 121.384 109.644 126.205C108.176 130.398 106.289 134.382 103.774 137.945C99.7904 142.558 94.7589 146.122 88.8889 148.218C87.0021 148.637 85.5346 149.057 83.8574 149.476C82.5996 149.476 81.9706 149.476 81.3417 149.686H79.0356C79.0356 149.895 61.2159 151.992 61.2159 151.992C66.457 150.314 74.0042 144.444 79.0356 132.914C80.9224 128.931 82.3899 124.109 83.2285 118.449C84.696 110.482 85.7442 88.4696 86.1635 87.0021C87.2117 80.9224 89.3082 76.9392 92.8721 74.2138C93.7107 73.5849 94.5493 72.956 95.5975 72.327C97.9036 71.0692 100.419 70.2306 103.354 69.392H103.774C104.403 69.392 105.031 68.9727 105.66 68.7631C106.08 68.7631 106.499 68.7631 106.918 68.5535H108.595C109.224 68.5535 110.063 68.5535 110.692 68.3438L129.769 66.2474V65.4088Z" />
      <path d="M148.637 104.822V115.304C147.799 123.061 147.379 124.528 145.912 128.931C144.654 132.704 142.767 136.268 140.461 139.413C136.897 143.606 132.285 146.751 127.044 148.637C125.577 149.057 124.109 149.476 122.642 149.686H122.013C121.384 149.686 120.964 149.686 120.335 149.895H118.239C118.239 150.105 102.306 151.992 102.306 151.992C106.918 150.524 113.836 145.073 118.449 134.801C120.126 131.027 121.384 126.834 122.222 121.803C123.48 114.465 124.528 94.7589 124.948 93.501C125.786 88.0503 127.673 84.4864 130.818 81.9706C131.656 81.3417 132.495 80.7128 133.333 80.2935H133.543C135.43 79.2453 137.736 78.4067 140.252 77.5681H140.671C141.3 77.5681 141.929 77.1488 142.348 77.1488C142.767 77.1488 142.977 77.1488 143.396 76.9392H144.864C145.493 76.9392 146.122 76.9392 146.751 76.7296H148.218L148.847 105.87L148.637 104.822Z" />
      <path d="M72.956 107.338C72.956 113.208 71.4885 118.449 69.8113 123.899C64.7799 139.203 52.6205 150.943 36.0587 151.992V100.419C36.0587 94.5493 37.3166 89.3082 38.9937 84.0671C43.6059 69.8113 56.1845 60.7966 71.0692 59.1195C81.3417 58.2809 91.8239 57.4423 102.096 56.6038C100 57.0231 85.7442 59.3291 77.5681 72.956C70.8595 84.0671 72.7463 95.1782 73.3753 97.9036V107.128L72.956 107.338Z" />
    </svg>
  );
}

/**
 * "TManage for Windows" on the product page (Figma 412:6707 EN / 412:6774 AR): the copy column
 * with the download capsule, the size line, the "Windows may ask you to confirm" note and the
 * browser line, beside an ink desktop window with the mark. Logical properties only, so Arabic
 * mirrors it. The download is a plain anchor: the installer is served by the one-process server,
 * not by Next.js, so it must neither be client-routed nor get an `/ar` prefix.
 */
export function DesktopAppSection() {
  const t = useT();
  return (
    <section id="desktop-app" className="tm-dl" aria-labelledby="dl-title">
      <div className="tm-web-container">
        <p className="tm-dl__eyebrow">{t(key('eyebrow'))}</p>
        <div className="tm-dl__card">
          <div className="tm-dl__copy">
            <h2 id="dl-title" className="tm-dl__title">
              {t(key('title'))}
            </h2>
            <p className="tm-dl__body">{t(key('body'))}</p>
            <div className="tm-dl__download">
              <a
                href={DESKTOP_INSTALLER_HREF}
                download
                className="tm-button tm-button--ink tm-button--feature tm-web-button tm-dl__button"
              >
                {t(key('download'))}
              </a>
              <p className="tm-dl__meta">
                {t(key('requirements')).replace('{size}', String(DESKTOP_INSTALLER_SIZE_MB))}
              </p>
            </div>
            <div className="tm-dl__note">
              <p className="tm-dl__note-title">{t(key('confirmTitle'))}</p>
              <p className="tm-dl__note-body">{t(key('confirmBody'))}</p>
            </div>
            <p className="tm-dl__browser">{t(key('browserNote'))}</p>
          </div>
          <div className="tm-dl-window" role="img" aria-label={t(key('windowLabel'))}>
            <div className="tm-dl-window__bar" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div className="tm-dl-window__body">
              <DesktopMark />
              <p className="tm-dl-window__name">TManage</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
