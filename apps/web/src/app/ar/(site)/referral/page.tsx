import type { Metadata } from 'next';
import { ReferralPage } from '../../../../components/website/pages/referral/ReferralPage';
import { REFERRAL_PAGE_COPY } from '../../../../content/referral/referral';
import { TITLE_SUFFIX } from '../../../../lib/route-titles';

/** 57-08 REFERRAL — "Invite an agency" in Arabic, `/ar/referral`. */
export const metadata: Metadata = {
  title: { absolute: `${REFERRAL_PAGE_COPY.ar.title}${TITLE_SUFFIX}` },
  description: REFERRAL_PAGE_COPY.ar.description,
};

export default function ArabicReferralRoute() {
  return <ReferralPage />;
}
