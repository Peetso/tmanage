import type { ReactNode } from 'react';
import { SignedInGate } from '../../components/session/SignedInGate';

/**
 * AUTHSTATE: a signed-in area. The server sends a request with no session cookie to sign-in
 * (`proxy.ts`, `signed-in-shell-gate.ts`); the shared session check (`SignedInGate`) confirms the
 * session before anything here renders.
 */
export default function Layout({ children }: { children: ReactNode }) {
  return <SignedInGate>{children}</SignedInGate>;
}
