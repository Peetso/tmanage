'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Badge, Button, InlineAlert } from '@tmanage/ui';
import { downloadTrailCsv } from '../../lib/api/session-intel';
import type { IntelDevice, IntelFacts, IntelNetwork } from '../../lib/api/session-intel';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';
import { LocationHonestyNote } from './LocationHonestyNote';
import { SignalPill } from './SignalPill';
import './session-intel.css';

const KIND_KEY: Readonly<Record<IntelNetwork['kind'], MessageKey>> = {
  residential: 'SessionIntel.kindResidential',
  hosting: 'SessionIntel.kindHosting',
  local: 'SessionIntel.kindLocal',
  unknown: 'SessionIntel.kindUnknown',
};

const DEVICE_KEY: Readonly<Record<IntelDevice['deviceType'], MessageKey>> = {
  desktop: 'SessionIntel.deviceDesktop',
  phone: 'SessionIntel.devicePhone',
  tablet: 'SessionIntel.deviceTablet',
  bot: 'SessionIntel.deviceBot',
  unknown: 'SessionIntel.deviceUnknown',
};

const DASH = '—';

/** "City, Country" from the parts the database knew; `null` when it knew none. */
export function placeOf(intel: IntelFacts | null | undefined): string | null {
  const where = intel?.location;
  if (!where) return null;
  const parts = [where.city ?? where.region, where.country].filter(
    (part): part is string => typeof part === 'string' && part !== '',
  );
  return parts.length > 0 ? parts.join(', ') : null;
}

function Ip({ value }: { value: string | null | undefined }) {
  return (
    <bdi dir="ltr" className="tm-intel-mono">
      {value ?? DASH}
    </bdi>
  );
}

/** Location cell: city and country with the "approx." badge, the IP under it. */
export function IntelLocationCell({
  intel,
  ip,
}: {
  intel: IntelFacts | null | undefined;
  ip?: string | null;
}) {
  const t = useT();
  const place = placeOf(intel);
  return (
    <span className="tm-intel-cell">
      <span className="tm-intel-cell__title">
        {place ?? DASH}
        {place ? <Badge>{t('SessionIntel.approx')}</Badge> : null}
      </span>
      {ip !== undefined ? (
        <span className="tm-intel-cell__sub">
          <Ip value={ip} />
        </span>
      ) : null}
    </span>
  );
}

function NetworkChips({ network }: { network: IntelNetwork }) {
  const t = useT();
  const chips: MessageKey[] = [];
  if (network.kind === 'hosting') chips.push('SessionIntel.chipHosting');
  if (network.tor) chips.push('SessionIntel.chipTor');
  if (network.vpnOrProxy === 'likely') chips.push('SessionIntel.chipVpn');
  if (chips.length === 0) return null;
  return (
    <span className="tm-intel-chips">
      {chips.map((key) => (
        <span key={key} className="tm-intel-chip">
          {t(key)}
        </span>
      ))}
    </span>
  );
}

/** Network cell: the owner, the AS number, and Hosting / Tor / VPN chips. */
export function IntelNetworkCell({ intel }: { intel: IntelFacts | null | undefined }) {
  const network = intel?.network;
  if (!network) return <span className="tm-intel-dash">{DASH}</span>;
  return (
    <span className="tm-intel-cell">
      <span className="tm-intel-cell__title">{network.owner ?? DASH}</span>
      {network.asn !== null ? (
        <bdi dir="ltr" className="tm-intel-cell__sub">
          AS{network.asn}
        </bdi>
      ) : null}
      <NetworkChips network={network} />
    </span>
  );
}

/** Device cell: browser over "OS · type". `fallback` is the raw label when no intel came. */
export function IntelDeviceCell({
  intel,
  fallback,
}: {
  intel: IntelFacts | null | undefined;
  fallback: string;
}) {
  const t = useT();
  const device = intel?.device;
  if (!device) return <span className="tm-intel-cell__title">{fallback}</span>;
  const sub = [device.os, t(DEVICE_KEY[device.deviceType])].filter(Boolean).join(' · ');
  return (
    <span className="tm-intel-cell">
      <span className="tm-intel-cell__title" title={device.raw ?? undefined}>
        {device.browser ?? fallback}
      </span>
      <span className="tm-intel-cell__sub">{sub}</span>
    </span>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="tm-intel-card">
      <h3 className="tm-intel-card__title">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="tm-intel-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * **SessionIntelCards** (Figma 504:29272) — IP, Location, Network, Device and Signal cards for one
 * session or sign-in. With no `intel` yet every value is a dash; the honest-limits note is part of
 * the set, because a location is never shown without it.
 */
export function SessionIntelCards({
  intel,
  rawUserAgent,
}: {
  intel: IntelFacts | null | undefined;
  rawUserAgent?: string | null;
}) {
  const t = useT();
  const where = intel?.location ?? null;
  const network = intel?.network ?? null;
  const device = intel?.device ?? null;
  const yesNo = (value: boolean) => t(value ? 'SessionIntel.yes' : 'SessionIntel.no');
  return (
    <div className="tm-intel-cards">
      <Card title={t('SessionIntel.ipTitle')}>
        <dl className="tm-intel-rows">
          <Row label={t('SessionIntel.ipFirst')}>
            <Ip value={intel?.ipFirst} />
          </Row>
          <Row label={t('SessionIntel.ipLast')}>
            <Ip value={intel?.ipLast} />
          </Row>
        </dl>
      </Card>
      <Card title={t('SessionIntel.locationTitle')}>
        <dl className="tm-intel-rows">
          <Row label={t('SessionIntel.city')}>
            <span className="tm-intel-cell__title">
              {where?.city ?? DASH}
              {where?.city ? <Badge>{t('SessionIntel.approx')}</Badge> : null}
            </span>
          </Row>
          <Row label={t('SessionIntel.region')}>{where?.region ?? DASH}</Row>
          <Row label={t('SessionIntel.country')}>
            {where?.country
              ? `${where.country}${where.countryCode ? ` (${where.countryCode})` : ''}`
              : DASH}
          </Row>
          <Row label={t('SessionIntel.postalCode')}>{where?.postalCode ?? DASH}</Row>
        </dl>
        {where?.attribution === 'DB-IP' ? (
          <p className="tm-intel-attribution">{t('SessionIntel.attribution')}</p>
        ) : null}
      </Card>
      <Card title={t('SessionIntel.networkTitle')}>
        <dl className="tm-intel-rows">
          <Row label={t('SessionIntel.owner')}>{network?.owner ?? DASH}</Row>
          <Row label={t('SessionIntel.asn')}>
            {network?.asn != null ? <bdi dir="ltr">AS{network.asn}</bdi> : DASH}
          </Row>
          <Row label={t('SessionIntel.type')}>{network ? t(KIND_KEY[network.kind]) : DASH}</Row>
          <Row label={t('SessionIntel.tor')}>{network ? yesNo(network.tor) : DASH}</Row>
          <Row label={t('SessionIntel.vpnOrProxy')}>
            {network
              ? t(
                  network.vpnOrProxy === 'likely'
                    ? 'SessionIntel.possible'
                    : 'SessionIntel.notSeen',
                )
              : DASH}
          </Row>
        </dl>
      </Card>
      <Card title={t('SessionIntel.deviceTitle')}>
        <dl className="tm-intel-rows">
          <Row label={t('SessionIntel.browser')}>{device?.browser ?? DASH}</Row>
          <Row label={t('SessionIntel.os')}>{device?.os ?? DASH}</Row>
          <Row label={t('SessionIntel.type')}>
            {device ? t(DEVICE_KEY[device.deviceType]) : DASH}
          </Row>
        </dl>
        {(device?.raw ?? rawUserAgent) ? (
          <p className="tm-intel-mono tm-intel-raw" dir="ltr">
            {device?.raw ?? rawUserAgent}
          </p>
        ) : null}
      </Card>
      <Card title={t('SessionIntel.signalTitle')}>
        <SignalPill automation={intel?.automation} withReasons />
        {intel?.automation ? (
          <p className="tm-intel-attribution">
            {t('SessionIntel.scoreLine').replace('{score}', String(intel.automation.score))}
          </p>
        ) : null}
      </Card>
      <LocationHonestyNote />
    </div>
  );
}

/**
 * **Session detail drawer** (Figma 504:29362; phone 504:29454; Arabic 504:29453). A side panel on
 * a wide screen and a bottom sheet on a phone (CSS only). Escape and the close button close it;
 * focus moves to the close button when it opens.
 */
export function SessionIntelDrawer({
  title,
  subtitle,
  intel,
  rawUserAgent,
  csvUrl,
  csvFileName,
  printHref,
  onClose,
  children,
}: {
  title: string;
  subtitle: string;
  intel: IntelFacts | null | undefined;
  rawUserAgent?: string | null;
  csvUrl: string;
  csvFileName: string;
  printHref: string;
  onClose: () => void;
  /** Extra actions after Download CSV / Save as PDF (End session). */
  children?: ReactNode;
}) {
  const t = useT();
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [csvFailed, setCsvFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="tm-intel-drawer-layer">
      <div className="tm-intel-scrim" aria-hidden="true" onClick={onClose} />
      <div className="tm-intel-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="tm-intel-drawer__head">
          <div>
            <h2 id={titleId} className="tm-intel-drawer__title">
              {title}
            </h2>
            <p className="tm-intel-drawer__sub">{subtitle}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="tm-intel-drawer__close"
            aria-label={t('SessionIntel.close')}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <SessionIntelCards intel={intel} rawUserAgent={rawUserAgent ?? null} />
        {csvFailed ? (
          <InlineAlert tone="danger" live>
            {t('SessionIntel.csvFailed')}
          </InlineAlert>
        ) : null}
        <div className="tm-intel-drawer__actions">
          <Button
            type="button"
            tone="outline"
            disabled={downloading}
            onClick={async () => {
              setDownloading(true);
              setCsvFailed(!(await downloadTrailCsv(csvUrl, csvFileName)));
              setDownloading(false);
            }}
          >
            {t('SessionIntel.downloadCsv')}
          </Button>
          <a
            className="tm-button tm-button--outline"
            href={printHref}
            target="_blank"
            rel="noopener"
          >
            {t('SessionIntel.saveAsPdf')}
          </a>
          {children}
        </div>
      </div>
    </div>
  );
}
