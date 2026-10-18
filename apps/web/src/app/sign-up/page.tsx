import type { Metadata } from 'next';
import { SignUpScreen } from '../../components/screens/SignUpScreen';

/**
 * **Sign up** — public self-service account creation (`PUBLIC_SIGNUP`, default on). The screen
 * asks the API whether sign-up is open and shows "not open" when the switch is off. The API
 * reserves the slug `sign-up`, so this static segment shadows no organization.
 */
export const metadata: Metadata = {
  title: 'Create your TManage account',
};

export default function SignUpPage() {
  return <SignUpScreen />;
}
