/** The web build (automated checks only) blocks nothing: the page is the browser's own. */
import type { BlockingStatus } from './content-blocking';

const STATUS: BlockingStatus = { supported: false, rules: 0, updatedAt: null, updating: false, error: null };

export function useBlockingStatus(): BlockingStatus {
  return STATUS;
}

export function configureBlocking(_enabled: boolean, _allowedSites: readonly string[]): void {}

export function configurePrivacy(_consent: boolean, _gpc: boolean, _consentAllowedSites: readonly string[]): void {}

export async function startBlocking(_enabled: boolean, _allowedSites: readonly string[]): Promise<void> {}

export async function refreshLists(): Promise<void> {}
