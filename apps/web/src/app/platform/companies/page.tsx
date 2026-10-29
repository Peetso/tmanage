import { redirect } from 'next/navigation';

/** The v1 address of the organizations list; v2 lives at /platform/organizations. */
export default function Page() {
  redirect('/platform/organizations');
}
