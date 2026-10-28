/**
 * Asking Corvus from the phone: the question goes to one of the chain's computers, which answers
 * it with its AI search and writes the answer back as it comes (sync collection `asks`). The
 * Assist tab groups them into conversations (lib/chat.ts).
 */
import { askList, type AskRecord } from '@corvus/shared';

/** This phone's questions, newest first. */
export function myAsks(records: Record<string, unknown>, self: string | null): AskRecord[] {
  return self ? askList(records, (a) => a.fromId === self) : [];
}
