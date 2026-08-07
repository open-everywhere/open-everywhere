export type DirectoryGrade = "attested" | "asserted" | "email-match";

export interface DirectoryAccount {
  readonly platform: string;
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
