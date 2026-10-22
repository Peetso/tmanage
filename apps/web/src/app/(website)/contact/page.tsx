import type { Metadata } from 'next';
import { ContactPage } from '../../../components/website/pages/contact/ContactPage';

export const metadata: Metadata = {
  title: 'Book a demo',
  description:
    'A 30-minute walkthrough with someone who has run client delivery. Bring a real project; we will map it live.',
};

/**
 * Public site — Book a demo / contact sales (`/contact`, WEB-17). The form posts to the existing
 * `@Public()` `POST /public/site/contact` (rate-limited per address), whose response is a bare
 * acknowledgement — so this route reflects no stored lead and takes no query parameter.
 */
export default function ContactRoute() {
  return <ContactPage />;
}
