import { useIncomingShare } from 'expo-sharing';

import { sharedText } from '@/lib/send';

/** Text or a link shared to Corvus from another app, and a way to mark it handled. */
export function useSharedText(): { text: string; clear: () => void } {
  const { sharedPayloads, clearSharedPayloads } = useIncomingShare();
  return { text: sharedText(sharedPayloads), clear: clearSharedPayloads };
}
