export type DirectoryGrade = "attested" | "asserted" | "email-match";

export interface DirectoryAccount {
  readonly platform: string;
  readonly tenant?: string;
  readonly nativeId: string;
  readonly grade: DirectoryGrade;
}

export interface DirectoryPerson {
  readonly externalId: string;
  readonly displayName: string;
  readonly email?: string;
  readonly accounts: readonly DirectoryAccount[];
  readonly groups: readonly string[];
  readonly deprovisioned: boolean;
}

export interface DirectoryProvider {
  readonly id: string;
  readonly name: string;
  listPeople(): Promise<readonly DirectoryPerson[]>;
  inspect?(): Promise<DirectoryInspection>;
}

export interface DirectorySourceReport {
  readonly platform: string;
  readonly tenant?: string;
  readonly source: string;
  readonly field: string;
  readonly grade: DirectoryGrade;
  readonly assignments: number;
  readonly mapped: number;
  readonly skipped: readonly { readonly reason: string; readonly count: number; readonly examples: readonly string[] }[];
}

export interface DirectoryGroupReport {
  readonly total: number;
  readonly read: readonly string[];
  readonly skipped: number;
  readonly allowlist?: readonly string[];
  readonly allowlistMissing: readonly string[];
}

export interface DirectoryInspection {
  readonly people: readonly DirectoryPerson[];
  readonly sources: readonly DirectorySourceReport[];
  readonly groups?: DirectoryGroupReport;
  readonly requests?: number;
}

let registered: DirectoryProvider | undefined;

export function registerDirectoryProvider(provider: DirectoryProvider): void {
  registered = provider;
}

export function directoryProvider(): DirectoryProvider | undefined {
  return registered;
}

export function resetDirectoryProvider(): void {
  registered = undefined;
}
