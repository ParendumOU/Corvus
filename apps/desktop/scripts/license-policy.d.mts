export declare const ALLOWED_LICENSES: string[];
export declare const SOURCE_URL: string;
export interface AcceptedCopyleft {
  /** The licence Corvus uses the package under. */
  license: string;
  /** What the package itself declares. */
  declared: string;
  reason: string;
  /** Licence files inside the package (not at its root) that the notices also reproduce. */
  files?: string[];
}
export declare const ACCEPTED_COPYLEFT: Record<string, AcceptedCopyleft>;
export declare function acceptedCopyleft(name: string, version: string): AcceptedCopyleft | null;
export declare function licenseOf(pkg: unknown): string;
export declare function isAllowedLicense(expression: unknown, allowed?: string[]): boolean;
export declare function packageRootOf(id: string): string | null;
