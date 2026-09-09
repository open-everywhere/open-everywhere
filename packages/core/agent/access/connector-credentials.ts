import { credentialEndpointProblems, type CredentialEndpointRules } from "./credential-endpoints.js";

export type ConnectorCredentialType = "api-key" | "service-oauth" | "user-oauth";

export function principalOf(type: ConnectorCredentialType): "app" | "user" {
  return type === "user-oauth" ? "user" : "app";
}

export type CredentialGrantFamily = "install" | "human-acting";

export type CredentialRefreshPosture = "manual-rotation" | "re-mint" | "refresh-token";

export interface CredentialLifecycle {
  readonly refresh: CredentialRefreshPosture;
  readonly ttlSeconds?: number;
}

export interface HumanActingSupport {
  readonly supported: boolean;
  readonly credentialTypes?: readonly ConnectorCredentialType[];
  readonly reason?: string;
}

export function grantFamilyOf(cred: { readonly grantFamily?: CredentialGrantFamily }): CredentialGrantFamily {
  return cred.grantFamily ?? "install";
}

export function isHumanActing(cred: { readonly grantFamily?: CredentialGrantFamily }): boolean {
  return grantFamilyOf(cred) === "human-acting";
}

export function principalOfCredential(cred: {
  readonly type: ConnectorCredentialType;
  readonly grantFamily?: CredentialGrantFamily;
}): "app" | "user" {
  return isHumanActing(cred) ? "user" : principalOf(cred.type);
}

export function humanActingSupport(cfg: {
  readonly humanActing?: HumanActingSupport;
}): "undeclared" | "vendor-incapable" | "supported" {
  if (!cfg.humanActing) return "undeclared";
  return cfg.humanActing.supported ? "supported" : "vendor-incapable";
}

export interface CredentialHomeRef {
  readonly kind: string;
  readonly config: Readonly<Record<string, unknown>>;
}

const VERCEL_CONNECT_HOME_KIND = "vercel-connect";

export function vercelConnectorHome(connector: string): CredentialHomeRef {
  return { kind: VERCEL_CONNECT_HOME_KIND, config: { connector } };
}

export function vercelConnectorOf(cred: { readonly home?: CredentialHomeRef }): string | undefined {
  if (cred.home?.kind !== VERCEL_CONNECT_HOME_KIND) return undefined;
  const c = cred.home.config.connector;
  return typeof c === "string" ? c : undefined;
}

export interface ConnectorCredential {
  readonly id: string;
  readonly type: ConnectorCredentialType;
  readonly grantFamily?: CredentialGrantFamily;
  readonly lifecycle?: CredentialLifecycle;
  readonly secretRef?: string;
  readonly broker?: string;
  readonly intake?: boolean;
  readonly home?: CredentialHomeRef;
  readonly dashboardUrl?: string;
  readonly endpoints?: CredentialEndpointRules;
}

export interface ConnectorCredentials {
  readonly connector: string;
  readonly allows: readonly ConnectorCredentialType[];
  readonly credentials: readonly ConnectorCredential[];
  readonly humanActing?: HumanActingSupport;
  readonly skill?: string;
  readonly description?: string;
}

export interface ResolvedConnectorCredential {
  readonly connector: string;
  readonly credential: string;
  readonly type: ConnectorCredentialType;
  readonly grantFamily: CredentialGrantFamily;
  readonly principal: "app" | "user";
  readonly secretRef?: string;
  readonly broker?: string;
  readonly home?: CredentialHomeRef;
  readonly endpoints?: CredentialEndpointRules;
  readonly memberPlane?: true;
}

export function defineConnectorCredentials(c: ConnectorCredentials): ConnectorCredentials {
  return c;
}

export interface ExclusiveCredentialHome {
  readonly name: string;
  readonly validFor: readonly ConnectorCredentialType[];
  validateConfig(config: Readonly<Record<string, unknown>>, where: string): void;
}

const EXCLUSIVE_HOMES = new Map<string, ExclusiveCredentialHome>();

export function registerExclusiveCredentialHome(home: ExclusiveCredentialHome): void {
  EXCLUSIVE_HOMES.set(home.name, home);
}

export function resetExclusiveCredentialHomes(): void {
  EXCLUSIVE_HOMES.clear();
  registerCoreExclusiveHomes();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function registerCoreExclusiveHomes(): void {
  registerExclusiveCredentialHome({
    name: VERCEL_CONNECT_HOME_KIND,
    validFor: ["service-oauth", "user-oauth"],
    validateConfig: (config, where) => {
      if (!isRecord(config) || typeof config.connector !== "string" || !config.connector) {
        throw new Error(`${where}: vercel-connect home needs a non-empty { connector }`);
      }
    },
  });
}
registerCoreExclusiveHomes();

export function assertConnectorCredentialsValid(catalogues: readonly ConnectorCredentials[]): void {
  const seen = new Set<string>();
  for (const p of catalogues) {
    if (!p.connector) throw new Error("connector credentials: missing connector slug");
    if (seen.has(p.connector)) {
      throw new Error(
        `connector "${p.connector}": a second credential catalogue names the same connector — one catalogue per connector, so merge the credential lists`,
      );
    }
    seen.add(p.connector);
    if (!p.allows.length) throw new Error(`connector "${p.connector}": empty credential allowlist`);

    if (p.humanActing) {
      const ha = p.humanActing;
      if (ha.supported) {
        if (!ha.credentialTypes?.length) {
          throw new Error(
            `connector "${p.connector}": humanActing.supported requires a non-empty credentialTypes — name which credential type(s) carry the human-acting grant for this vendor (it is a SEPARATE mint from the install credential, so it has its own type)`,
          );
        }
        for (const t of ha.credentialTypes) {
          if (!p.allows.includes(t)) {
            throw new Error(
              `connector "${p.connector}": humanActing.credentialTypes lists "${t}", which is not in the connection's allowlist (${p.allows.join(", ")}) — a human-acting grant still has to be a type the connection accepts`,
            );
          }
        }
        if (new Set(ha.credentialTypes).size !== ha.credentialTypes.length) {
          throw new Error(`connector "${p.connector}": humanActing.credentialTypes has duplicates`);
        }
      } else {
        if (!ha.reason) {
          throw new Error(
            `connector "${p.connector}": humanActing.supported:false requires a \`reason\` — record the STRUCTURAL vendor fact (e.g. "no scope combination lets an app post chat as a human"), so "the vendor cannot do this" never reads as "nobody configured it"`,
          );
        }
        if (ha.credentialTypes) {
          throw new Error(
            `connector "${p.connector}": humanActing.supported:false must NOT list credentialTypes — the vendor cannot issue a human-acting credential of any type`,
          );
        }
      }
    }

    const credIds = new Set<string>();
    for (const c of p.credentials) {
      if (credIds.has(c.id)) throw new Error(`connector "${p.connector}": duplicate credential id "${c.id}"`);
      credIds.add(c.id);
      const where = `connector "${p.connector}" credential "${c.id}"`;

      if (c.home) {
        const h = EXCLUSIVE_HOMES.get(c.home.kind);
        if (!h) {
          throw new Error(`${where}: unknown credential home kind "${c.home.kind}" — no ExclusiveCredentialHome is registered for it (register one; a new home vendor is registration-only)`);
        }
        if (!h.validFor.includes(c.type)) {
          throw new Error(`${where}: a ${c.type} credential cannot be homed at "${h.name}" (valid for: ${h.validFor.join(", ")})`);
        }
        h.validateConfig(c.home.config, where);
        if (c.secretRef) throw new Error(`${where}: a ${h.name}-homed credential must NOT carry a secretRef — its secret lives at the ${h.name} home, not on a broker (one home; mutual exclusivity)`);
        if (c.broker) throw new Error(`${where}: a ${h.name}-homed credential must NOT carry a broker — the home is the connector-plane transport, not a token-vending broker (mutual exclusivity)`);
      } else {
        if (c.type === "api-key" && !c.secretRef) throw new Error(`${where}: api-key needs a secretRef`);
        if (c.type === "api-key" && !c.broker) {
          throw new Error(`${where}: api-key needs an explicit broker stamp ("env" | "db" | ...) — a credential has exactly one home; unstamped-follows-selection is not allowed`);
        }
        if (c.type === "service-oauth" || c.type === "user-oauth") {
          throw new Error(`${where}: ${c.type} needs a home — a vercel-connect connector (vercelConnectorHome) or a registered exclusive vendor home`);
        }
      }

      if (c.intake === false && c.type !== "api-key") {
        throw new Error(`${where}: intake:false is only valid on an api-key credential (it marks operator-env plumbing that is never offered for intake)`);
      }

      if (isHumanActing(c)) {
        const state = humanActingSupport(p);
        if (state === "undeclared") {
          throw new Error(
            `${where}: grantFamily "human-acting" needs connector "${p.connector}" to DECLARE \`humanActing\` support first. It is undeclared — which is not the same as unsupported: research the vendor and declare either { supported: true, credentialTypes: [...] } or { supported: false, reason: "..." }.`,
          );
        }
        if (state === "vendor-incapable") {
          throw new Error(
            `${where}: connector "${p.connector}" is declared STRUCTURALLY INCAPABLE of a human-acting credential — ${p.humanActing?.reason ?? "no reason recorded"}. This is a VENDOR limitation, not a configuration gap: no credential, scope, or broker change can grant it.`,
          );
        }
        if (!p.humanActing?.credentialTypes?.includes(c.type)) {
          throw new Error(
            `${where}: a ${c.type} credential cannot carry connector "${p.connector}"'s human-acting grant (declared for: ${p.humanActing?.credentialTypes?.join(", ") ?? "none"}) — "act as a user" is a distinct mint with a distinct token shape, not a mode of any credential you happen to hold`,
          );
        }
      }

      if (c.lifecycle) {
        const postures: readonly CredentialRefreshPosture[] = ["manual-rotation", "re-mint", "refresh-token"];
        if (!postures.includes(c.lifecycle.refresh)) {
          throw new Error(`${where}: lifecycle.refresh must be one of ${postures.join(" | ")}`);
        }
        const ttl = c.lifecycle.ttlSeconds;
        if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0)) {
          throw new Error(`${where}: lifecycle.ttlSeconds must be a positive number of seconds (omit it when the credential does not expire, or when the vendor TTL is unverified)`);
        }
      }

      const endpointProblems = credentialEndpointProblems(c.endpoints, where);
      if (endpointProblems.length > 0) throw new Error(endpointProblems.join("\n"));
    }
  }
}

export function expandConnectorGrant(
  grant: { readonly name: string; readonly credential: string },
  cfg: ConnectorCredentials | undefined,
  opts: {
    readonly dm: boolean;
    readonly memberPlane?: ReadonlySet<string>;
  },
): { resolved: ResolvedConnectorCredential | null; warnings: readonly string[] } {
  if (!cfg) {
    return {
      resolved: null,
      warnings: [
        `grant names connector "${grant.name}", which has no credential catalogue in this deployment's config — ignored`,
      ],
    };
  }
  const cred = cfg.credentials.find((c) => c.id === grant.credential);
  if (!cred) {
    return {
      resolved: null,
      warnings: [`connector "${cfg.connector}": grant references unknown credential "${grant.credential}" — ignored`],
    };
  }
  const principal = principalOfCredential(cred);

  const memberPlane = principal === "user" && !opts.dm && opts.memberPlane?.has(`${cfg.connector}/${cred.id}`) === true;

  if (principal === "user" && !opts.dm && !memberPlane) {
    const why = isHumanActing(cred) ? `${cred.type}, human-acting grant` : cred.type;
    return {
      resolved: null,
      warnings: [
        `connector "${cfg.connector}": credential "${cred.id}" is user-principal (${why}) — ` +
          `personal credentials resolve only in DMs, never on a channel/domain binding, unless the ` +
          `domain declares this connector's member role (access/member-grant.ts). Ignored.`,
      ],
    };
  }

  if (!cfg.allows.includes(cred.type)) {
    return {
      resolved: null,
      warnings: [
        `connector "${cfg.connector}": credential "${cred.id}" (${cred.type}) is not in the connection's ` +
          `allowlist (${cfg.allows.join(", ")}) — ignored`,
      ],
    };
  }

  return {
    resolved: {
      connector: cfg.connector,
      credential: cred.id,
      type: cred.type,
      grantFamily: grantFamilyOf(cred),
      principal,
      secretRef: cred.secretRef,
      broker: cred.broker,
      home: cred.home,
      endpoints: cred.endpoints,
      ...(memberPlane ? { memberPlane: true as const } : {}),
    },
    warnings: [],
  };
}

let registeredConnectorCredentials: readonly ConnectorCredentials[] = [];

export function setRegisteredConnectorCredentials(catalogues: readonly ConnectorCredentials[]): void {
  registeredConnectorCredentials = catalogues;
}

export function resetRegisteredConnectorCredentials(): void {
  registeredConnectorCredentials = [];
}

export function findConnectorCredential(connector: string, credentialId: string): ConnectorCredential | undefined {
  const cfg = registeredConnectorCredentials.find((c) => c.connector === connector);
  return cfg?.credentials.find((c) => c.id === credentialId);
}
