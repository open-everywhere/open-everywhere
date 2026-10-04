import type { ConnectorCredentials, ConnectorCredential } from "./connector-credentials.js";
import { overlayModuleHeader, sameOverlayModuleAfterHeader, unwrapOverlayModule, wrapOverlayModule, type OverlayModuleGrammar } from "./overlay-module.js";

export interface CredentialBindingOverride {
  readonly connector: string;
  readonly credential: string;
  readonly broker?: string;
  readonly secretRef?: string;
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
  apply(cred: ConnectorCredential, o: CredentialBindingOverride): ConnectorCredential;
}

const OVERLAY_HOMES = new Map<string, OverlayHomeCodec>();

export function registerOverlayHome(codec: OverlayHomeCodec): void {
  OVERLAY_HOMES.set(codec.kind, codec);
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
        throw new CredentialBindingsCodemodError("every override needs string { connector, credential, broker, secretRef }");
      }
      if (!o.broker || !o.secretRef) {
        throw new CredentialBindingsCodemodError(`override for ${where} has a blank field — connector/credential/broker/secretRef are all required`);
      }
      return { broker: o.broker, secretRef: o.secretRef };
    },
    serialize: (o) => ({ broker: o.broker, secretRef: o.secretRef }),
    sameHome: (a, b) => a.broker === b.broker && a.secretRef === b.secretRef,
    apply: (c, ov) => {
      const { home: _h, ...rest } = c;
      return { ...rest, broker: ov.broker, secretRef: ov.secretRef };
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
    if (!isRecord(o) || typeof o.connector !== "string" || typeof o.credential !== "string") {
      throw new CredentialBindingsCodemodError("every override needs string { connector, credential } and exactly one home (broker+secretRef)");
    }
    if (!o.connector || !o.credential) {
      throw new CredentialBindingsCodemodError(`override for "${o.connector}/${o.credential}" has a blank connector/credential — both are required`);
    }
    if (o.connector.includes(":") || o.credential.includes(":")) {
      throw new CredentialBindingsCodemodError(`override connector/credential ids must not contain ":" (got "${o.connector}"/"${o.credential}")`);
    }
    const where = `"${o.connector}/${o.credential}"`;
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
    const dupKey = `${o.connector} ${o.credential}`;
    if (seen.has(dupKey)) throw new CredentialBindingsCodemodError(`credential-bindings file has a duplicate override for "${o.connector}/${o.credential}" — one home per credential`);
    seen.add(dupKey);

    overrides.push({ connector: o.connector, credential: o.credential, ...claimed[0].parseRaw(o, where) });
  }
  return { overrides };
}

export function stringifyCredentialBindings(file: CredentialBindingsFile): string {
  const overrides = [...file.overrides]
    .sort((a, b) => a.connector.localeCompare(b.connector) || a.credential.localeCompare(b.credential))
    .map((o) => {
      const home = overlayHomeFor(o);
      return { connector: o.connector, credential: o.credential, ...(home ? home.serialize(o) : {}) };
    });
  return JSON.stringify({ overrides }, null, 2) + "\n";
}

const CREDENTIAL_BINDINGS_MODULE: OverlayModuleGrammar = {
  what: "credential-bindings overlay",
  header: overlayModuleHeader("credential-bindings overlay", "@open-everywhere/core/agent/access/credential-bindings-codemod.js"),
  typeImport: 'import type { CredentialBindingsFile } from "@open-everywhere/core/agent/access/credential-bindings-codemod.js";',
  typeName: "CredentialBindingsFile",
};

export function emitCredentialBindingsModule(file: CredentialBindingsFile): string {
  return wrapOverlayModule(CREDENTIAL_BINDINGS_MODULE, stringifyCredentialBindings(file));
}

export function parseCredentialBindingsModule(text: string): CredentialBindingsFile {
  const file = parseCredentialBindingsFile(
    unwrapOverlayModule(CREDENTIAL_BINDINGS_MODULE, text, (m) => new CredentialBindingsCodemodError(m)),
  );
  if (!sameOverlayModuleAfterHeader(emitCredentialBindingsModule(file), text)) {
    throw new CredentialBindingsCodemodError(
      "credential-bindings overlay is not in canonical form — re-emitting its own data does not reproduce the file below its header, so it has been hand-edited. Run `npx oe overlays normalize` and commit the result (the codemod refuses to rewrite a file it did not write).",
    );
  }
  return file;
}

export function renormalizeCredentialBindingsModule(text: string): string {
  return emitCredentialBindingsModule(
    parseCredentialBindingsFile(unwrapOverlayModule(CREDENTIAL_BINDINGS_MODULE, text, (m) => new CredentialBindingsCodemodError(m))),
  );
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
  if (override.connector.includes(":") || override.credential.includes(":")) {
    throw new CredentialBindingsCodemodError(`override connector/credential ids must not contain ":" (got "${override.connector}"/"${override.credential}")`);
  }
  const existing = file.overrides.find((o) => o.connector === override.connector && o.credential === override.credential);
  if (existing && sameHome(existing, override)) {
    return { file, changed: false };
  }
  const others = file.overrides.filter((o) => !(o.connector === override.connector && o.credential === override.credential));
  return { file: { overrides: [...others, { ...override }] }, changed: true };
}

export function applyOverridesToConnectorCredentials(
  catalogues: readonly ConnectorCredentials[],
  overrides: readonly CredentialBindingOverride[],
): readonly ConnectorCredentials[] {
  if (overrides.length === 0) return catalogues;
  const byConnector = new Map<string, CredentialBindingOverride[]>();
  for (const o of overrides) {
    const list = byConnector.get(o.connector) ?? [];
    list.push(o);
    byConnector.set(o.connector, list);
  }
  return catalogues.map((p) => {
    const forThis = byConnector.get(p.connector);
    if (!forThis) return p;
    const credentials = p.credentials.map((c): ConnectorCredential => {
      const ov = forThis.find((o) => o.credential === c.id);
      if (!ov) return c;
      return overlayHomeFor(ov)?.apply(c, ov) ?? c;
    });
    return { ...p, credentials };
  });
}
