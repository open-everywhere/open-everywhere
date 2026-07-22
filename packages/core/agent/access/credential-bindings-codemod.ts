import type { Provider, ProviderCredential } from "./providers.js";

export interface CredentialBindingExecutorHome {
  readonly integration: string;
  readonly owner: string;
  readonly connection: string;
}

export interface CredentialBindingOverride {
  readonly provider: string;
  readonly credential: string;
  readonly broker?: string;
  readonly secretRef?: string;
  readonly executor?: CredentialBindingExecutorHome;
}

export interface CredentialBindingsFile {
  readonly overrides: readonly CredentialBindingOverride[];
}

export class CredentialBindingsCodemodError extends Error {}

export function emptyCredentialBindingsFile(): CredentialBindingsFile {
  return { overrides: [] };
}

export interface OverlayHomeCodec {
  readonly kind: string;
  readonly display: string;
  readonly emptyHint: string;
  claimsRaw(o: Record<string, unknown>): boolean;
  parseRaw(o: Record<string, unknown>, where: string): Partial<CredentialBindingOverride>;
  claims(o: CredentialBindingOverride): boolean;
  serialize(o: CredentialBindingOverride): Record<string, unknown>;
  sameHome(a: CredentialBindingOverride, b: CredentialBindingOverride): boolean;
  apply(cred: ProviderCredential, o: CredentialBindingOverride): ProviderCredential;
}

const OVERLAY_HOMES = new Map<string, OverlayHomeCodec>();

export function registerOverlayHome(codec: OverlayHomeCodec): void {
  OVERLAY_HOMES.set(codec.kind, codec);
}

export function resetOverlayHomes(): void {
  OVERLAY_HOMES.clear();
  registerCoreOverlayHomes();
}

function overlayHomeFor(o: CredentialBindingOverride): OverlayHomeCodec | undefined {
  for (const codec of OVERLAY_HOMES.values()) if (codec.claims(o)) return codec;
  return undefined;
}

function registerCoreOverlayHomes(): void {
  registerOverlayHome({
    kind: "broker",
    display: "a broker home",
    emptyHint: "{ broker, secretRef }",
    claimsRaw: (o) => "broker" in o || "secretRef" in o,
    claims: (o) => o.broker !== undefined || o.secretRef !== undefined,
    parseRaw: (o, where) => {
      if (typeof o.broker !== "string" || typeof o.secretRef !== "string") {
        throw new CredentialBindingsCodemodError("every override needs string { provider, credential, broker, secretRef }");
      }
      if (!o.broker || !o.secretRef) {
        throw new CredentialBindingsCodemodError(`override for ${where} has a blank field — provider/credential/broker/secretRef are all required`);
      }
      return { broker: o.broker, secretRef: o.secretRef };
    },
    serialize: (o) => ({ broker: o.broker, secretRef: o.secretRef }),
    sameHome: (a, b) => a.broker === b.broker && a.secretRef === b.secretRef,
    apply: (c, ov) => ({ ...c, broker: ov.broker, secretRef: ov.secretRef }),
  });
  registerOverlayHome({
    kind: "executor",
    display: "an executor home",
    emptyHint: "{ executor }",
    claimsRaw: (o) => "executor" in o,
    claims: (o) => o.executor !== undefined,
    parseRaw: (o, where) => {
      const e = o.executor;
      if (!isRecord(e) || typeof e.integration !== "string" || typeof e.owner !== "string" || typeof e.connection !== "string") {
        throw new CredentialBindingsCodemodError(`override for ${where}: executor home needs string { integration, owner, connection }`);
      }
      if (!e.integration || !e.owner || !e.connection) {
        throw new CredentialBindingsCodemodError(`override for ${where}: executor home has a blank field — integration/owner/connection are all required`);
      }
      if (e.integration.includes(":") || e.owner.includes(":") || e.connection.includes(":")) {
        throw new CredentialBindingsCodemodError(`override for ${where}: executor integration/owner/connection must not contain ":"`);
      }
      return { executor: { integration: e.integration, owner: e.owner, connection: e.connection } };
    },
    serialize: (o) => ({
      executor: { integration: o.executor!.integration, owner: o.executor!.owner, connection: o.executor!.connection },
    }),
    sameHome: (a, b) =>
      !!a.executor &&
      !!b.executor &&
      a.executor.integration === b.executor.integration &&
      a.executor.owner === b.executor.owner &&
      a.executor.connection === b.executor.connection,
    apply: (c, ov) => {
      const { secretRef: _s, broker: _b, vercelConnector: _v, ...rest } = c;
      return { ...rest, executor: ov.executor };
    },
  });
}
registerCoreOverlayHomes();

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseCredentialBindingsFile(value: unknown): CredentialBindingsFile {
  if (!isRecord(value)) throw new CredentialBindingsCodemodError("credential-bindings file must be a JSON object with an `overrides` array");
  const keys = Object.keys(value).filter((k) => k !== "$comment");
  const unknown = keys.filter((k) => k !== "overrides");
  if (unknown.length > 0) throw new CredentialBindingsCodemodError(`credential-bindings file has unknown top-level key(s): ${unknown.join(", ")}`);
  if (!Array.isArray(value.overrides)) throw new CredentialBindingsCodemodError("credential-bindings file needs an `overrides` array (use [] when empty)");

  const overrides: CredentialBindingOverride[] = [];
  const seen = new Set<string>();
  for (const o of value.overrides) {
    if (!isRecord(o) || typeof o.provider !== "string" || typeof o.credential !== "string") {
      throw new CredentialBindingsCodemodError("every override needs string { provider, credential } and exactly one home (broker+secretRef, or executor)");
    }
    if (!o.provider || !o.credential) {
      throw new CredentialBindingsCodemodError(`override for "${o.provider}/${o.credential}" has a blank provider/credential — both are required`);
    }
    if (o.provider.includes(":") || o.credential.includes(":")) {
      throw new CredentialBindingsCodemodError(`override provider/credential ids must not contain ":" (got "${o.provider}"/"${o.credential}")`);
    }
    const where = `"${o.provider}/${o.credential}"`;
    const claimed = [...OVERLAY_HOMES.values()].filter((h) => h.claimsRaw(o));
    if (claimed.length > 1) {
      const phrase =
        claimed.length === 2
          ? `has BOTH ${claimed[0].display} and ${claimed[1].display}`
          : `declares more than one home (${claimed.map((h) => h.display).join(", ")})`;
      throw new CredentialBindingsCodemodError(`override for ${where} ${phrase} — exactly one is allowed (one home per credential)`);
    }
    if (claimed.length === 0) {
      throw new CredentialBindingsCodemodError(
        `override for ${where} has no home — set ${[...OVERLAY_HOMES.values()].map((h) => h.emptyHint).join(" or ")}`,
      );
    }
    const dupKey = `${o.provider} ${o.credential}`;
    if (seen.has(dupKey)) throw new CredentialBindingsCodemodError(`credential-bindings file has a duplicate override for "${o.provider}/${o.credential}" — one home per credential`);
    seen.add(dupKey);

    overrides.push({ provider: o.provider, credential: o.credential, ...claimed[0].parseRaw(o, where) });
  }
  return { overrides };
}

export function parseCredentialBindingsText(text: string): CredentialBindingsFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new CredentialBindingsCodemodError(`credential-bindings file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseCredentialBindingsFile(json);
}

export function stringifyCredentialBindings(file: CredentialBindingsFile): string {
  const overrides = [...file.overrides]
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.credential.localeCompare(b.credential))
    .map((o) => {
      const home = overlayHomeFor(o);
      return { provider: o.provider, credential: o.credential, ...(home ? home.serialize(o) : {}) };
    });
  return JSON.stringify({ overrides }, null, 2) + "\n";
}

function sameHome(a: CredentialBindingOverride, b: CredentialBindingOverride): boolean {
  const ca = overlayHomeFor(a);
  const cb = overlayHomeFor(b);
  if (!ca || !cb || ca.kind !== cb.kind) return false;
  return ca.sameHome(a, b);
}

export interface ApplyBindingOverrideResult {
  readonly file: CredentialBindingsFile;
  readonly changed: boolean;
}

export function applyBindingOverride(file: CredentialBindingsFile, override: CredentialBindingOverride): ApplyBindingOverrideResult {
  if (override.provider.includes(":") || override.credential.includes(":")) {
    throw new CredentialBindingsCodemodError(`override provider/credential ids must not contain ":" (got "${override.provider}"/"${override.credential}")`);
  }
  const existing = file.overrides.find((o) => o.provider === override.provider && o.credential === override.credential);
  if (existing && sameHome(existing, override)) {
    return { file, changed: false };
  }
  const others = file.overrides.filter((o) => !(o.provider === override.provider && o.credential === override.credential));
  return { file: { overrides: [...others, { ...override }] }, changed: true };
}

export function applyOverridesToProviders(providers: readonly Provider[], overrides: readonly CredentialBindingOverride[]): readonly Provider[] {
  if (overrides.length === 0) return providers;
  const byProvider = new Map<string, CredentialBindingOverride[]>();
  for (const o of overrides) {
    const list = byProvider.get(o.provider) ?? [];
    list.push(o);
    byProvider.set(o.provider, list);
  }
  return providers.map((p) => {
    const forThis = byProvider.get(p.name);
    if (!forThis) return p;
    const credentials = p.credentials.map((c): ProviderCredential => {
      const ov = forThis.find((o) => o.credential === c.id);
      if (!ov) return c;
      return overlayHomeFor(ov)?.apply(c, ov) ?? c;
    });
    return { ...p, credentials };
  });
}
