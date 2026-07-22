export interface CredentialHomeStoreInput {
  readonly org: string;
  readonly ref: string;
  readonly plaintext: string;
  readonly provider?: string;
  readonly domain?: string;
  readonly createdBy: string;
  readonly parsed: Readonly<Record<string, string>>;
  readonly deps?: Readonly<Record<string, unknown>>;
}

export interface CredentialHome {
  readonly name: string;
  hostWriteAvailable(): boolean;
  store(input: CredentialHomeStoreInput): Promise<void>;
}

const HOMES = new Map<string, CredentialHome>();

export function registerCredentialHome(home: CredentialHome): void {
  HOMES.set(home.name, home);
}

export function credentialHome(name: string): CredentialHome | undefined {
  return HOMES.get(name);
}

export function registeredCredentialHomes(): readonly CredentialHome[] {
  return [...HOMES.values()];
}

export function resetCredentialHomes(): void {
  HOMES.clear();
}

export function hostWriteHomeAvailable(homes: Iterable<CredentialHome>): boolean {
  for (const h of homes) if (h.hostWriteAvailable()) return true;
  return false;
}
