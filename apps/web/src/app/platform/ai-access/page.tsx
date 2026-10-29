import { redirect } from 'next/navigation';

/**
 * The AI kill switch moved into Platform settings (PA-10, D1 "AI access" card). The old address
 * keeps working: it lands on the card.
 */
export default function Page(): never {
  redirect('/platform/settings#ai-access');
}
