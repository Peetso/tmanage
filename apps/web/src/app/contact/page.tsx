import { ContactScreen } from '../../components/screens/ContactScreen';

/**
 * **Public site — Contact** (module 1, x161).
 *
 * The public contact / lead intake. A public visitor reaches it without a session and without an
 * organization, so it renders `ContactScreen` (framed by the org-less `IdentityShell`) and nothing
 * else. The screen posts to the `@Public()` `POST /public/site/contact`, whose response is a bare
 * acknowledgement — so this route reflects no stored lead and takes no query parameter.
 */
export default function ContactPage() {
  return <ContactScreen />;
}
