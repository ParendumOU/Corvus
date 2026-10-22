import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export const RECOVERY_PHRASE_WORDS = 24;

/** Canonical form: NFKD, lower case, single spaces. Users may paste with odd whitespace/case. */
export function normalizeRecoveryPhrase(phrase: string): string {
  return phrase.normalize("NFKD").trim().toLowerCase().split(/\s+/).join(" ");
}

/** 256 bits of CSPRNG entropy encoded as a 24-word English BIP39 mnemonic. */
export function generateRecoveryPhrase(): string {
  return generateMnemonic(wordlist, 256);
}

export function validateRecoveryPhrase(phrase: string): boolean {
  const normalized = normalizeRecoveryPhrase(phrase);
  return normalized.split(" ").length === RECOVERY_PHRASE_WORDS && validateMnemonic(normalized, wordlist);
}

export function recoveryPhraseToSeed(phrase: string): Uint8Array {
  if (!validateRecoveryPhrase(phrase)) throw new Error("Invalid recovery phrase");
  return mnemonicToSeedSync(normalizeRecoveryPhrase(phrase), "");
}
