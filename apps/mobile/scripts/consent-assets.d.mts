// Types of scripts/consent-assets.mjs for the tests.
import type { CompactCMPRuleset, IndexedCMPRuleset } from '@duckduckgo/autoconsent';

export const RULES_HEADER: string;
export const PORT_PLACEHOLDER: string;
export function ruleStringIds(rule: IndexedCMPRuleset['r'][number]): number[];
export function packRules(rules: IndexedCMPRuleset): string;
export function canonicalRuleset(set: CompactCMPRuleset): string;
export function consentCases(rules: IndexedCMPRuleset, filterCompactRules: (rules: IndexedCMPRuleset, context: { url: string; mainFrame: boolean }) => CompactCMPRuleset): string;
export function snippetSources(evalSnippets: Record<string, unknown>): Record<string, string>;
export function buildConsentAssets(outDir: string, options?: { ios?: boolean }): Promise<void>;
