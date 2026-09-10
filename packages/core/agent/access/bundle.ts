import type { OperatorApprover } from "./approver-chain.js";
import { preApprovalRuleProblems, type PreApprovalRule } from "./pre-approval-rules.js";
import { repoCapabilityProblems, type RepoCapability } from "./repo-capabilities.js";
import { resourceGrantProblems, type ResourceGrant } from "./resource-grant.js";
import { isQualifiedPrincipalKey } from "../identity/principal-key.js";
import { parseSurfaceKeyEntry } from "../identity/surface-key-grammar.js";
import { tenantRungRemedy } from "./tenant-admission.js";
import { isValidLinkSetRef } from "../identity/link-set-ref.js";
import type { Group } from "../identity/groups.js";

export type ScopeLevel = "org" | "tenant" | "domain" | "surface" | "group" | "principal";

export interface Scope {
  readonly level: ScopeLevel;
  readonly tenant?: string;
  readonly domain?: string;
  readonly surface?: string;
  readonly group?: string;
  readonly principal?: string;
}

export type CredentialType = "bearer" | "basic" | "github-app";

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface CustomHeader {
  readonly name: string;
  readonly prefix?: string;
  readonly secretRef: string;
}

export interface CredentialAuthorizationDetail {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface Connection {
  readonly id: string;
  readonly credentialType: CredentialType;
  readonly secretRef: string;
  readonly broker?: string;
  readonly allowedWebsites: readonly string[];
  readonly pathPrefixes?: readonly string[];
  readonly customHeaders?: readonly CustomHeader[];
  readonly methods?: readonly HttpMethod[];
  readonly authorizationDetails?: readonly CredentialAuthorizationDetail[];
}

export function normaliseEgressHost(host: string): string {
  return host.trim().toLowerCase();
}

export function egressHostsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  return wildcardCovers(a, b) || wildcardCovers(b, a);
}

function wildcardCovers(pattern: string, other: string): boolean {
  if (!pattern.startsWith("*.")) return false;
  const suffix = pattern.slice(1);
  return other.endsWith(suffix) && other.length > suffix.length;
}

export type ConnectorContentOrigin = "internal" | "external";

export interface ConnectorContentOriginOverrides {
  readonly default: ConnectorContentOrigin;
  readonly except: Readonly<Record<string, ConnectorContentOrigin>>;
}

export type ConnectorContentOriginSpec = ConnectorContentOrigin | ConnectorContentOriginOverrides;

export interface ConnectorGrant {
  readonly name: string;
  readonly credential: string;
  readonly contentOrigin?: ConnectorContentOriginSpec;
}

export type ConnectorGrantSpec = string | ConnectorGrant;

const KNOWN_CONTENT_ORIGINS: ReadonlySet<string> = new Set<ConnectorContentOrigin>(["internal", "external"]);

export function connectorGrantName(grant: ConnectorGrantSpec): string {
  return typeof grant === "string" ? grant : grant.name;
}

export function connectorGrantContentOrigin(grant: ConnectorGrantSpec): ConnectorContentOriginSpec | undefined {
  return typeof grant === "string" ? undefined : grant.contentOrigin;
}

export function connectorGrantCredential(grant: ConnectorGrantSpec): string | undefined {
  return typeof grant === "string" ? undefined : grant.credential;
}

export function contentOriginForTool(spec: ConnectorContentOriginSpec, bareToolName: string): ConnectorContentOrigin {
  if (typeof spec === "string") return spec;
  const override = Object.hasOwn(spec.except, bareToolName) ? spec.except[bareToolName] : undefined;
  return override === "internal" || override === "external" ? override : spec.default;
}

export function bundleConnectorNames(bundle: Pick<Bundle, "connectors">): readonly string[] {
  return (bundle.connectors ?? []).map(connectorGrantName);
}

export interface ConnectorOpGating {
  readonly connector: string;
  readonly gated?: readonly string[];
  readonly destructive?: readonly string[];
}

export interface AwsRoleGrant {
  readonly roleArn: string;
  readonly region?: string;
  readonly audience?: string;
  readonly allow: readonly string[];
}

export interface RepoGrant {
  readonly repo: string;
  readonly capabilities?: readonly RepoCapability[];
}

export type RepoGrantSpec = string | RepoGrant;

export function repoGrantName(grant: RepoGrantSpec): string {
  return typeof grant === "string" ? grant : grant.repo;
}

export function repoGrantCapabilities(grant: RepoGrantSpec): readonly RepoCapability[] {
  return typeof grant === "string" ? [] : (grant.capabilities ?? []);
}

export interface Bundle {
  readonly name: string;
  readonly title?: string;
  readonly connections?: readonly Connection[];
  readonly connectors?: readonly ConnectorGrantSpec[];
  readonly connectorOps?: readonly ConnectorOpGating[];
  readonly repos?: readonly RepoGrantSpec[];
  readonly resourceGrants?: readonly ResourceGrant[];
  readonly domains?: readonly string[];
  readonly plugins?: readonly string[];
  readonly awsRoles?: readonly AwsRoleGrant[];
  readonly approvers?: readonly OperatorApprover[];
  readonly instructions?: string;
  readonly preApprovalRules?: readonly PreApprovalRule[];
}

export interface Binding {
  readonly bundle: string;
  readonly scope: Scope;
  readonly allowBroad?: string;
}

export const PACKAGE_REGISTRY_HOSTS: readonly string[] = [
  "registry.npmjs.org",
  "jsr.io",
  "npm.jsr.io",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
];

export function defineBundle(bundle: Bundle): Bundle {
  return bundle;
}

export function defineBinding(binding: Binding): Binding {
  return binding;
}

const REPO_FORM = /^[\w.-]+\/[\w.-]+$/u;

const ROLE_ARN_FORM = /^arn:aws[\w-]*:iam::\d{12}:role\/.+$/u;

const AWS_REGION_FORM = /^[a-z]{2}(?:-[a-z]+)+-\d+$/u;

function isOverlyBroadHost(pattern: string): boolean {
  return pattern === "*" || /^\*\.[^.]+$/u.test(pattern);
}

function broadHostProblems(bundleName: string, field: string, hosts: readonly string[]): string[] {
  return hosts
    .filter(isOverlyBroadHost)
    .map(
      (h) =>
        `  bundle "${bundleName}" ${field} pattern "${h}" is overly broad (matches ${h === "*" ? "every host" : "an entire TLD"}) — name real hosts, wildcard only one org's subdomains (e.g. "*.googleapis.com")`,
    );
}

function isMachineWrittenBundleName(name: string): boolean {
  return name.startsWith("grants:") || name.startsWith("agent:");
}

function contentOriginProblems(bundleName: string, connector: string, spec: unknown): string[] {
  const known = [...KNOWN_CONTENT_ORIGINS].map((t) => JSON.stringify(t)).join(", ");
  const where = `bundle "${bundleName}" connector "${connector}"`;
  if (spec === undefined) {
    return [
      `  ${where} has no \`contentOrigin\` — say who authors the bytes it returns: ` +
        `contentOrigin: "internal" (only org members can write what it returns) or "external" (anyone can), ` +
        `or contentOrigin: { default: "internal", except: { "<bare-tool-name>": "external" } } when only some of its tools reach outside content`,
    ];
  }
  if (typeof spec === "string" || spec === null || typeof spec !== "object") {
    if (KNOWN_CONTENT_ORIGINS.has(spec as string)) return [];
    return [
      `  ${where} declares unknown contentOrigin ${JSON.stringify(spec)} — known: ${known}, or { default, except } for per-tool grain (omit the field entirely to declare nothing)`,
    ];
  }
  const obj = spec as { default?: unknown; except?: unknown };
  const bad: string[] = [];
  if (!KNOWN_CONTENT_ORIGINS.has(obj.default as string)) {
    bad.push(`  ${where} declares contentOrigin.default ${JSON.stringify(obj.default)} — known: ${known}`);
  }
  if (obj.except === null || typeof obj.except !== "object" || Array.isArray(obj.except)) {
    bad.push(`  ${where} declares a contentOrigin object whose \`except\` is not a { toolName: origin } map — got ${JSON.stringify(obj.except)}`);
    return bad;
  }
  const except = obj.except as Record<string, unknown>;
  const toolNames = Object.keys(except);
  if (toolNames.length === 0) {
    bad.push(`  ${where} declares contentOrigin \`except: {}\` — an empty exception map is just ${JSON.stringify(obj.default)}; write the scalar, or name the tools that differ`);
  }
  for (const tool of toolNames) {
    if (tool.trim() === "") {
      bad.push(`  ${where} declares a contentOrigin exception for an empty tool name — name the BARE tool the override applies to`);
      continue;
    }
    if (tool.startsWith(`${connector}__`)) {
      bad.push(`  ${where} declares a contentOrigin exception for "${tool}" — \`except\` keys are BARE tool names; drop the "${connector}__" prefix (write "${tool.slice(connector.length + 2)}")`);
    }
    if (!KNOWN_CONTENT_ORIGINS.has(except[tool] as string)) {
      bad.push(`  ${where} declares contentOrigin exception "${tool}" as ${JSON.stringify(except[tool])} — known: ${known}`);
    }
  }
  return bad;
}

export function assertBundlesValid(bundles: readonly Bundle[]): void {
  const bad: string[] = [];
  const seen = new Set<string>();
  const seenRuleIds = new Set<string>();
  for (const b of bundles) {
    bad.push(...preApprovalRuleProblems(b.name, b.preApprovalRules, seenRuleIds));
    if (seen.has(b.name)) bad.push(`  bundle name "${b.name}" is defined more than once (bindings reference bundles by name — names must be unique)`);
    seen.add(b.name);
    for (const c of b.connections ?? []) {
      if (c.allowedWebsites.length === 0) {
        bad.push(`  bundle "${b.name}" connection "${c.id}" has an empty allowedWebsites — the credential can be sent nowhere; name the host(s) it may reach`);
      }
      bad.push(...broadHostProblems(b.name, `connection "${c.id}" allowedWebsites`, c.allowedWebsites));
    }
    bad.push(...broadHostProblems(b.name, "domains", b.domains ?? []));
    const connectors = new Set<string>();
    for (const grant of b.connectors ?? []) {
      if (typeof grant === "string") {
        bad.push(
          `  bundle "${b.name}" grants connector "${grant}" as a bare slug — a grant names the identity it reaches the connector as: ` +
            `{ name: "${grant}", credential: "<a credential id from the connector's catalogue>", contentOrigin: "internal" | "external" }. ` +
            `The machine-written overlays write { name, credential } and omit contentOrigin; every other bundle declares all three.`,
        );
      } else if (grant === null || typeof grant !== "object" || typeof (grant as ConnectorGrant).name !== "string" || (grant as ConnectorGrant).name.trim() === "") {
        bad.push(`  bundle "${b.name}" has a connector grant that is not a { name, credential, contentOrigin } object — got ${JSON.stringify(grant)}`);
        continue;
      } else {
        const g = grant as ConnectorGrant;
        if (typeof g.credential !== "string" || g.credential.trim() === "") {
          bad.push(
            `  bundle "${b.name}" grants connector "${g.name}" with no \`credential\` — name which configured identity this scope reaches it as, ` +
              `e.g. { name: "${g.name}", credential: "team-key", contentOrigin: "external" }. The ids come from that connector's credential catalogue ` +
              `(agent/access/connector-credentials.ts); \`npm run lint:connections\` fails a grant naming one that is not configured.`,
          );
        }
        if (g.contentOrigin !== undefined || !isMachineWrittenBundleName(b.name)) {
          bad.push(...contentOriginProblems(b.name, g.name, g.contentOrigin));
        }
      }
      const name = connectorGrantName(grant);
      if (connectors.has(name)) bad.push(`  bundle "${b.name}" grants connector "${name}" more than once — remove the duplicate`);
      connectors.add(name);
    }
    const gatedConnectors = new Set<string>();
    for (const g of b.connectorOps ?? []) {
      const key = g.connector.trim().toLowerCase();
      if (key === "") {
        bad.push(`  bundle "${b.name}" has a connectorOps entry with an empty connector name — name the connector its ops belong to`);
        continue;
      }
      if (gatedConnectors.has(key)) {
        bad.push(`  bundle "${b.name}" declares connectorOps for "${g.connector}" more than once — merge the entries (two entries for one connector make the declaration ambiguous)`);
      }
      gatedConnectors.add(key);
      const ops = [...(g.gated ?? []), ...(g.destructive ?? [])];
      if (ops.length === 0) {
        bad.push(`  bundle "${b.name}" connectorOps entry for "${g.connector}" names no ops — it raises nothing; list ops under gated/destructive or drop the entry`);
      }
      if (ops.some((op) => op.trim() === "")) {
        bad.push(`  bundle "${b.name}" connectorOps entry for "${g.connector}" has an empty op name — every entry must name a real operation (or "*" for all of them)`);
      }
    }
    const repoNames = new Set<string>();
    for (const grant of b.repos ?? []) {
      if (grant === null || (typeof grant !== "string" && typeof grant !== "object") || Array.isArray(grant)) {
        bad.push(`  bundle "${b.name}" has a repo grant that is neither "owner/name" nor a { repo, capabilities } object — got ${JSON.stringify(grant)}`);
        continue;
      }
      const name = repoGrantName(grant as RepoGrantSpec);
      if (typeof name !== "string" || !REPO_FORM.test(name)) {
        bad.push(`  bundle "${b.name}" repo ${JSON.stringify(name)} must be bare owner/name form (e.g. "acme/web") — not a URL, a bare owner, or an owner/name/extra path`);
      }
      if (repoNames.has(name)) {
        bad.push(`  bundle "${b.name}" grants repo ${JSON.stringify(name)} more than once — merge the entries (two entries for one repo make its capabilities ambiguous)`);
      }
      repoNames.add(name);
      if (typeof grant === "object") {
        for (const k of Object.keys(grant)) {
          if (k !== "repo" && k !== "capabilities") {
            bad.push(`  bundle "${b.name}" repo grant ${JSON.stringify(name)} has unknown field "${k}" — a repo grant carries { repo, capabilities } only`);
          }
        }
        bad.push(...repoCapabilityProblems(`bundle "${b.name}" repo ${JSON.stringify(name)}`, (grant as RepoGrant).capabilities));
      }
    }
    bad.push(...resourceGrantProblems(`bundle "${b.name}"`, b.resourceGrants));
    const roleArns = new Set<string>();
    for (const grant of b.awsRoles ?? []) {
      if (!ROLE_ARN_FORM.test(grant.roleArn)) {
        bad.push(`  bundle "${b.name}" awsRoles roleArn "${grant.roleArn}" must be an IAM role ARN (e.g. "arn:aws:iam::123456789012:role/oe-agent")`);
      }
      if (roleArns.has(grant.roleArn)) {
        bad.push(`  bundle "${b.name}" grants awsRole "${grant.roleArn}" more than once — remove the duplicate`);
      }
      roleArns.add(grant.roleArn);
      if (grant.region !== undefined && !AWS_REGION_FORM.test(grant.region)) {
        bad.push(`  bundle "${b.name}" awsRoles region "${grant.region}" is not a well-formed AWS region (e.g. "eu-west-2")`);
      }
      if (grant.allow === undefined || grant.allow.length === 0) {
        bad.push(
          `  bundle "${b.name}" awsRoles grant "${grant.roleArn}" has no \`allow\` list — REQUIRED: spell unrestricted access explicitly as allow: ["*"] (an absent narrowing and a decision not to narrow must not look the same; at runtime an allow-less grant REFUSES, never passes through)`,
        );
      }
      const seenAllow = new Set<string>();
      for (const entry of grant.allow ?? []) {
        if (entry.trim() === "") {
          bad.push(`  bundle "${b.name}" awsRoles allow entry for "${grant.roleArn}" is empty/whitespace — an allow entry must be a "service" (e.g. "logs") or "service:operation" (e.g. "s3:cp")`);
          continue;
        }
        const colons = entry.split(":").length - 1;
        if (colons > 1) {
          bad.push(`  bundle "${b.name}" awsRoles allow entry "${entry}" (role "${grant.roleArn}") is malformed — an entry has at most one ":" ("service" or "service:operation")`);
          continue;
        }
        if (colons === 1) {
          const [service, operation] = entry.split(":");
          if (service!.trim() === "" || operation!.trim() === "") {
            bad.push(`  bundle "${b.name}" awsRoles allow entry "${entry}" (role "${grant.roleArn}") is malformed — both sides of the ":" must be non-empty ("service:operation", e.g. "s3:cp")`);
            continue;
          }
        }
        const [svc, op] = entry.split(":");
        const norm = op === undefined ? svc!.trim().toLowerCase() : `${svc!.trim().toLowerCase()}:${op.trim().toLowerCase().replace(/_/gu, "-")}`;
        if (seenAllow.has(norm)) {
          bad.push(`  bundle "${b.name}" awsRoles allow lists "${entry}" (role "${grant.roleArn}") more than once — remove the duplicate`);
        }
        seenAllow.add(norm);
      }
    }
    const approverNames = new Set<string>();
    for (const a of b.approvers ?? []) {
      const name = a.name?.trim() ?? "";
      if (name === "") {
        bad.push(`  bundle "${b.name}" has an approver with an empty name — the audit row's resolvedBy is "custom:<name>", so every element needs one`);
        continue;
      }
      if (approverNames.has(name)) bad.push(`  bundle "${b.name}" declares approver "${name}" more than once — names must be unique within a bundle (resolvedBy would be ambiguous)`);
      approverNames.add(name);
      if (typeof a.approve !== "function") bad.push(`  bundle "${b.name}" approver "${name}" has no callable approve() — an element that cannot answer is config that means nothing`);
      if (a.mayAllow === true && (a.source === undefined || a.source === "operator")) {
        bad.push(`  bundle "${b.name}" approver "${name}" sets mayAllow on an operator-authored element — mayAllow is the clamp escape for source:"connector"/"remote" elements only (an operator element already holds the full verdict range)`);
      }
    }
  }
  if (bad.length > 0) {
    throw new Error(
      "open-everywhere: invalid access bundle(s):\n" + bad.join("\n") + "\n(access/bundle.ts / docs/how-it-works/access-and-scoping.md)",
    );
  }
}

type ScopeAddressField = "tenant" | "domain" | "surface" | "group" | "principal";
const LEVEL_FIELD: Record<string, ScopeAddressField | null | undefined> = {
  org: null,
  tenant: "tenant",
  domain: "domain",
  surface: "surface",
  group: "group",
  principal: "principal",
};

export const TENANT_KEY = /^[^/\s]+\/[^/\s]+$/u;
export const SURFACE_KEY = /^[^/\s]+\/[^/\s]+\/\S+$/u;

export function assertBindingsValid(bindings: readonly Binding[], bundles: readonly Bundle[], groups?: readonly Group[]): void {
  const known = new Set(bundles.map((b) => b.name));
  const knownGroups = groups === undefined ? undefined : new Set(groups.map((g) => g.name));
  const bad: string[] = [];
  for (const b of bindings) {
    const where = `binding "${b.bundle}" (${b.scope.level} scope)`;
    if (!known.has(b.bundle)) bad.push(`  ${where} references unknown bundle "${b.bundle}" — define it in the bundles list or fix the name`);
    const { level, tenant, domain, surface, group, principal } = b.scope;
    const required = LEVEL_FIELD[level];
    if (required === undefined) {
      bad.push(`  ${where} has an unknown scope.level "${level}" — the levels are org | tenant | domain | surface | group | principal`);
      continue;
    }
    for (const [field, value] of [["tenant", tenant], ["domain", domain], ["surface", surface], ["group", group], ["principal", principal]] as const) {
      if (field === required) {
        if (!value) bad.push(`  ${where} needs scope.${field} — a ${level}-level binding can never match without one`);
      } else if (value !== undefined) {
        bad.push(
          `  ${where} also sets scope.${field} — a ${level}-level scope carries ${required ? `only scope.${required}` : "no address field"}; drop it or change the level`,
        );
      }
    }
    if (tenant && !TENANT_KEY.test(tenant)) {
      bad.push(
        `  ${where} scope.tenant "${tenant}" must be the PLATFORM-QUALIFIED tenant key "platform/<tenant-id>" (e.g. "slack/T0123ABC", "discord/1300000000000000100", "github/acme") — a bare vendor id has no platform and will NEVER match`,
      );
    }
    if (surface && !SURFACE_KEY.test(surface)) {
      bad.push(
        `  ${where} scope.surface "${surface}" must be the fully-qualified surface key "platform/<tenant-id>/<container-id>" (e.g. "slack/T0123ABC/C0123ABC") — the SAME form memory domains' \`channels\` use; a bare channel id will NEVER match`,
      );
    }
    if (domain?.includes("/")) {
      bad.push(
        `  ${where} scope.domain "${domain}" contains "/" — a domain scope takes the BARE domain name from memory/config/domains.ts ("payments"), deliberately NOT tenant-qualified: domains are cross-platform, so one grant is one binding`,
      );
    }
    if (group !== undefined && group.trim().length === 0) {
      bad.push(`  ${where} scope.group is empty — a group-level binding takes the BARE group name from agent/identity/groups.ts (e.g. "payments-team")`);
    } else if (group !== undefined && knownGroups !== undefined && !knownGroups.has(group)) {
      bad.push(
        `  ${where} scope.group "${group}" is not a declared person-group — define it with defineGroup() in agent/identity/groups.ts (or fix the name). A binding onto a group nobody declared can never match, so it is refused rather than ignored.`,
      );
    }
    if (principal !== undefined && !isQualifiedPrincipalKey(principal) && !isValidLinkSetRef(principal)) {
      bad.push(
        principal.startsWith("dm:")
          ? `  ${where} scope.principal "${principal}" still carries the old \`workspace: "dm:<id>"\` sentinel — the DM universe is the first-class \`principal\` level now, so drop the "dm:" prefix and write the PLATFORM-QUALIFIED key "platform/<principal-id>" (e.g. "slack/U0123ABC")`
          : `  ${where} scope.principal "${principal}" must be the qualified principal key "platform/<principal-id>" — or, on a tenant-scoped platform, "platform/<tenant-id>/<principal-id>" (e.g. "slack/T0AB1CD2E/U0123ABC", "discord/300000000000000104") — or a link-set reference "linkSet:<link-set-id>" (one human across their confirmed accounts). A BARE member id has no platform namespace and will NEVER match, and on Slack a key missing its workspace has no tenant namespace and will never match either (identity/principal-key.ts, identity/link-set-ref.ts).${tenantRungRemedy(principal)}`,
      );
    }
  }
  if (bad.length > 0) {
    throw new Error(
      "open-everywhere: invalid access binding(s):\n" + bad.join("\n") + "\n(access/bundle.ts / docs/how-it-works/access-and-scoping.md)",
    );
  }
}
