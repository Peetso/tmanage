import type { Metadata } from 'next';
import { ReferralPage } from '../../../components/website/pages/referral/ReferralPage';
import { REFERRAL_PAGE_COPY } from '../../../content/referral/referral';

export const metadata: Metadata = {
  title: REFERRAL_PAGE_COPY.en.title,
  description: REFERRAL_PAGE_COPY.en.description,
};

/** 57-08 REFERRAL — "Invite an agency", `/referral` (Arabic twin at `/ar/referral`). */
export default function ReferralRoute() {
  return <ReferralPage />;
}
