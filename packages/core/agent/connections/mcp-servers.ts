import type { Binding, Bundle } from "../access/bundle.js";
import { vercelConnectorHome, type ConnectorCredentials } from "../access/connector-credentials.js";
import { EVERYONE_GROUP } from "../identity/everyone-group.js";
import { processRegistryMap } from "../lib/process-registry.js";
import type { ConnectionSignIn, DiscoverySignIn, StaticConfidentialSignIn } from "./connection-sign-in.js";

export type McpServerDiscoverySignIn = Omit<DiscoverySignIn, "resource">;

export type McpServerSignIn = McpServerDiscoverySignIn | StaticConfidentialSignIn;

export interface McpServerPersonalSurface {
  readonly platform: string;
  readonly label: string;
}

export interface McpServerDeclaration {
  readonly name: string;
  readonly url: string;
  readonly description: string;
  readonly signIn?: McpServerSignIn;
  readonly personalSurface?: McpServerPersonalSurface;
  readonly people?: {
    readonly groups: readonly string[];
    readonly allowBroad?: string;
  };
}

const MCP_SERVER_NAME = /^[a-z][a-z0-9-]{0,63}$/u;

const MCP_SERVER_PERSONAL_CREDENTIAL = "user-oauth";
const MCP_SERVER_ORG_CREDENTIAL = "workspace-oauth";

export function mcpServerHomeRef(name: string): string {
  return `mcp-server/${name}`;
}

function mcpServerBundleName(name: string): string {
  return `mcp-server:${name}`;
}

function declarationProblems(s: McpServerDeclaration, where: string): string[] {
  const bad: string[] = [];
  if (typeof s.name !== "string" || !MCP_SERVER_NAME.test(s.name)) {
    bad.push(`${where}: name must match ${MCP_SERVER_NAME} (lowercase, a letter first) — it becomes agent/connections/<name>.ts.`);
  }
  let url: URL | undefined;
  try {
    url = new URL(s.url);
  } catch {
    bad.push(`${where}: url "${String(s.url)}" is not a URL.`);
  }
  if (url !== undefined) {
    if (url.protocol !== "https:") bad.push(`${where}: url must be https — a sign-in token never travels in clear text.`);
    if (url.username !== "" || url.password !== "") bad.push(`${where}: url carries a user-info part — a credential in a URL is a secret in Git. Use signIn.`);
    if (url.search !== "") bad.push(`${where}: url carries a query string — a token in a URL is a secret in Git. Use signIn.`);
    if (url.hash !== "") bad.push(`${where}: url carries a fragment.`);
  }
  if (typeof s.description !== "string" || s.description.trim() === "") {
    bad.push(`${where}: description is empty — the model reads it to decide when to call this server.`);
  }
  const signIn = s.signIn as (McpServerSignIn & { clientSecret?: unknown; resource?: unknown }) | undefined;
  if (signIn !== undefined) {
    if ("clientSecret" in signIn) bad.push(`${where}: signIn carries a literal clientSecret — name its credential-store REF in clientSecretRef instead.`);
    if ("resource" in signIn) bad.push(`${where}: signIn carries a resource — the server's url is the resource.`);
    if (signIn.mode === "static-confidential") {
      if (typeof signIn.clientId !== "string" || signIn.clientId.trim() === "") bad.push(`${where}: a static-confidential signIn needs a clientId.`);
      if (typeof signIn.clientSecretRef !== "string" || signIn.clientSecretRef.trim() === "") {
        bad.push(`${where}: a static-confidential signIn needs a clientSecretRef (the REF of the secret, never the value).`);
      }
    } else if (signIn.mode !== undefined && signIn.mode !== "discovery-dcr-pkce") {
      bad.push(`${where}: signIn.mode "${String(signIn.mode)}" is not a sign-in dialect (discovery-dcr-pkce | static-confidential).`);
    }
  }
  if (s.personalSurface !== undefined) {
    const { platform, label } = s.personalSurface;
    if (typeof platform !== "string" || !/^[a-z][a-z0-9-]*$/u.test(platform)) {
      bad.push(`${where}: personalSurface.platform must be a bare platform name (e.g. "slack") — it narrows the DM binding.`);
    }
    if (typeof label !== "string" || label.trim() === "") bad.push(`${where}: personalSurface.label is empty — the seat's copy names the platform with it.`);
  }
  if (s.people !== undefined) {
    const groups = s.people.groups;
    if (!Array.isArray(groups) || groups.length === 0 || groups.some((g) => typeof g !== "string" || g.trim() === "")) {
      bad.push(`${where}: people.groups must name at least one person-group. Omit people to give every person the server in their own DM.`);
    }
    if (s.people.allowBroad !== undefined && (typeof s.people.allowBroad !== "string" || s.people.allowBroad.trim() === "")) {
      bad.push(`${where}: people.allowBroad is empty — the escape must name the reason this broad grant is deliberate.`);
    }
  }
  return bad;
}

export function defineMcpServers(servers: readonly McpServerDeclaration[]): readonly McpServerDeclaration[] {
  const bad: string[] = [];
  const seen = new Set<string>();
  servers.forEach((s, i) => {
    const where = `MCP server ${typeof s?.name === "string" ? `"${s.name}"` : `#${i}`}`;
    bad.push(...declarationProblems(s, where));
    if (seen.has(s.name)) bad.push(`${where}: declared twice — one name is one connection.`);
    seen.add(s.name);
  });
  if (bad.length > 0) {
    throw new Error(`agent/access/mcp-servers.ts is not valid:\n  ${bad.join("\n  ")}`);
  }
  const frozen = Object.freeze(servers.map((s) => Object.freeze({ ...s })));
  DECLARED.clear();
  for (const s of frozen) DECLARED.set(s.name, s);
  return frozen;
}

const DECLARED = processRegistryMap<McpServerDeclaration>("mcp-servers.declared.v1");

export function declaredMcpServers(): readonly McpServerDeclaration[] {
  return [...DECLARED.values()];
}

export function mcpServerConnectionSignIn(server: McpServerDeclaration): ConnectionSignIn {
  const signIn = server.signIn;
  if (signIn !== undefined && signIn.mode === "static-confidential") return signIn;
  return { ...(signIn ?? {}), mode: "discovery-dcr-pkce", resource: server.url };
}

export function mcpServerConnectorCredentials(servers: readonly McpServerDeclaration[]): ConnectorCredentials[] {
  return servers.map((s): ConnectorCredentials => {
    const home = vercelConnectorHome(mcpServerHomeRef(s.name));
    const endpoints = { hosts: [new URL(s.url).hostname] };
    if (s.personalSurface !== undefined) {
      return {
        description: s.description,
        connector: s.name,
        allows: ["user-oauth"],
        credentials: [{ id: MCP_SERVER_PERSONAL_CREDENTIAL, type: "user-oauth", home, endpoints }],
      };
    }
    return {
      description: s.description,
      connector: s.name,
      allows: ["service-oauth", "user-oauth"],
      credentials: [
        { id: MCP_SERVER_PERSONAL_CREDENTIAL, type: "user-oauth", home, endpoints },
        { id: MCP_SERVER_ORG_CREDENTIAL, type: "service-oauth", home, endpoints },
      ],
    };
  });
}

export function mcpServerBundles(servers: readonly McpServerDeclaration[]): Bundle[] {
  return servers.map((s): Bundle => ({
    name: mcpServerBundleName(s.name),
    connectors: [{ name: s.name, credential: MCP_SERVER_PERSONAL_CREDENTIAL, contentOrigin: "external" }],
    instructions:
      s.personalSurface !== undefined
        ? personalSurfaceInstructions(s.name, s.personalSurface)
        : `Your ${s.name} connector in this DM acts as this person's own ${s.name} account: it reaches what they can ` +
          `see there, as them. If they have not signed in yet, the first call posts a "Connect my account" card.`,
  }));
}

function personalSurfaceInstructions(name: string, surface: McpServerPersonalSurface): string {
  const { label } = surface;
  return (
    `The \`${name}\` connection is "search ${label} as you": ${label}'s own MCP server, signed in as THIS person. It sees ` +
    `what they see in ${label} and it acts in their name. It is not your normal ${label} route. Answer from your own ` +
    `${label} access (the bot) first. Use \`${name}\` only when the bot cannot see what was asked — a channel or a ` +
    `conversation the bot is not in — or when the person asks you to act as them. The first time, ask in your own words: ` +
    `"I can only see channels I am in. Want me to see what you see?" Go on only when they say yes. If they have not ` +
    `signed in, the first call posts a "Connect my account" card. Say plainly which answers came from their account. ` +
    `A post, a reply or any other write as them posts an approval card first, and nothing is sent until they approve it.`
  );
}

export function mcpServerBindings(servers: readonly McpServerDeclaration[]): Binding[] {
  return servers.flatMap((s): Binding[] => {
    const bundle = mcpServerBundleName(s.name);
    const people = s.people;
    const platform = s.personalSurface !== undefined ? { platform: s.personalSurface.platform } : {};
    if (people !== undefined) {
      return people.groups.map((group): Binding => ({
        bundle,
        scope: { level: "group", group, ...platform },
        ...(people.allowBroad !== undefined ? { allowBroad: people.allowBroad } : {}),
      }));
    }
    return [
      {
        bundle,
        scope: { level: "group", group: EVERYONE_GROUP, ...platform },
        allowBroad:
          "a declared MCP server: every person reaches it in their OWN DM as THEMSELVES, through their own sign-in " +
          "(agent/access/mcp-servers.ts). A personal credential never resolves in a channel.",
      },
    ];
  });
}
