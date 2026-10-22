'use client';

import { PlatformAiAccessScreen } from '../../../components/platform/PlatformAiAccessScreen';

/** Platform admin — the AI kill switch (OPS-2..5). The API decides who may see it (404 for everyone not listed). */
export default function Page() {
  return <PlatformAiAccessScreen />;
}
