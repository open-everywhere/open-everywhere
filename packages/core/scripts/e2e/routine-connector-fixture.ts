import { connectorGrantCredential, connectorGrantName, type Binding, type Bundle } from "../../agent/access/bundle.js";
import { vercelConnectorOf, type ConnectorCredentials } from "../../agent/access/connector-credentials.js";
import { domainForChannel, type Domain } from "../../agent/memory/domain.js";
import { loadAppBindings, loadAppBundles, loadAppConnectorCredentials, loadAppDomains } from "./app-config.js";
import type { Routine } from "../../agent/routines/routine.js";

export const NOTION_MCP_HOST = "mcp.notion.com";

export const ROUTINE_CONNECTOR_WRITE_OP = "notion__notion-create-pages";

export type RoutineConnectorFixture =
  | {
      readonly ok: true;
      readonly domain: string;
      readonly bundle: string;
      readonly credential: string;
      readonly oauthHome?: string;
    }
  | { readonly ok: false; readonly reason: string };

function bindingCovers(binding: Binding, input: { readonly surfaceKey: string; readonly domain: string | undefined }): boolean {
  const scope = binding.scope;
  if (scope.level === "org") return true;
  if (scope.level === "tenant") return scope.tenant !== undefined && input.surfaceKey.startsWith(`${scope.tenant}/`);
  if (scope.level === "domain") return scope.domain !== undefined && scope.domain === input.domain;
  if (scope.level === "surface") return scope.surface === input.surfaceKey;
  return false;
}

export function routineConnectorFixture(input: {
  readonly surfaceKey: string;
  readonly connector: string;
  readonly op: string;
  readonly mcpHost: string;
  readonly domains: readonly Domain[];
  readonly bundles: readonly Bundle[];
  readonly bindings: readonly Binding[];
  readonly credentials: readonly ConnectorCredentials[];
}): RoutineConnectorFixture {
  const domain = domainForChannel(input.surfaceKey, input.domains)?.name;
  const byName = new Map(input.bundles.map((b) => [b.name, b] as const));
  const catalogue = input.credentials.find((c) => c.connector === input.connector);

  const blocked: string[] = [];
  for (const binding of input.bindings) {
    if (!bindingCovers(binding, { surfaceKey: input.surfaceKey, domain })) continue;
    const bundle = byName.get(binding.bundle);
    const grant = bundle?.connectors?.find((g) => connectorGrantName(g) === input.connector);
    if (bundle === undefined || grant === undefined) continue;
    const credentialId = connectorGrantCredential(grant);
    if (credentialId === undefined) {
      blocked.push(`bundle "${bundle.name}" grants "${input.connector}" in the bare-slug form, which names no credential and resolves to nothing`);
      continue;
    }
    const credential = catalogue?.credentials.find((c) => c.id === credentialId);
    if (credential === undefined) {
      blocked.push(`bundle "${bundle.name}" grants "${input.connector}" as credential "${credentialId}", which the connector's catalogue does not configure`);
      continue;
    }
    const hosts = credential.endpoints?.hosts;
    if (hosts !== undefined && !hosts.includes(input.mcpHost)) {
      blocked.push(
        `bundle "${bundle.name}" grants "${input.connector}" as credential "${credentialId}", whose endpoint rules admit only ${hosts.join(", ")} — ` +
          `the connector's MCP host is ${input.mcpHost}, so connections/connector-auth.ts refuses before the host is dialed and no tool is ever injected`,
      );
      continue;
    }
    const oauthHome = credential.type === "service-oauth" ? vercelConnectorOf(credential) : undefined;
    return { ok: true, domain: domain ?? "(no explicit domain)", bundle: bundle.name, credential: credentialId, ...(oauthHome ? { oauthHome } : {}) };
  }

  const where = domain === undefined ? `surface ${input.surfaceKey} (in no explicit domain)` : `domain "${domain}" (surface ${input.surfaceKey})`;
  if (blocked.length === 0) {
    return {
      ok: false,
      reason:
        `RED-until-fixture: no bundle bound to ${where} grants the "${input.connector}" connector at all, so ${input.op} is never mounted and an ` +
        "unattended fire has no tool to call. Add a `connectors: [{ name: \"" +
        `${input.connector}\", credential: <id>, contentOrigin: … }]` +
        '` grant to a bundle in agent/access/bundles.ts and bind it to that domain. A `principal`-scoped binding does not count: personal bindings resolve only in the DM universe.',
    };
  }
  return {
    ok: false,
    reason: `RED-until-fixture: every "${input.connector}" grant reaching ${where} is blocked — ${blocked.join("; ")}. An OAuth-armed credential for this connector is what would arm it.`,
  };
}

export function routineConnectorFixtureClaim(
  fixture: Extract<RoutineConnectorFixture, { readonly ok: true }>,
  input: { readonly connector: string; readonly op: string; readonly mcpHost: string },
): string {
  return (
    `connector "${input.connector}" is granted in domain "${fixture.domain}" by bundle "${fixture.bundle}" as credential "${fixture.credential}", ` +
    `whose endpoint rules admit ${input.mcpHost}. NOT verified by this preflight: that the connector's MCP server declares ${input.op} — ` +
    "the server lists its tools at runtime and no tracked config names them"
  );
}

export async function deployedRoutineConnectorFixture(input: { readonly surfaceKey: string; readonly connector: string; readonly op: string; readonly mcpHost: string }): Promise<RoutineConnectorFixture> {
  return routineConnectorFixture({
    ...input,
    domains: await loadAppDomains(),
    bundles: await loadAppBundles(),
    bindings: await loadAppBindings(),
    credentials: await loadAppConnectorCredentials(),
  });
}

export function routineConnectorWriteSteps(op: string, note: string): string {
  return (
    "Delegate this to a worker with the `agent` tool and pass it these instructions verbatim: " +
    `"Call \`connection_search\` for the Notion page-creation operation, then call \`${op}\` with a new page titled 'OE e2e ${note}' whose one-line body contains the exact token ${note}. ` +
    "Do not load any skill and do not use the notion-rest scripts. " +
    'Report exactly what the operation returned. A refusal is what a call returned, never something concluded without making one." ' +
    "Then report the worker's answer."
  );
}

export function routineConnectorFirePrompt(op: string, note: string, fireWord: string): string {
  return (
    `${routineConnectorWriteSteps(op, note)} ` +
    `Whether the page is created or the write is refused, report back here what was tried and what the system said, ending that report with the word ${fireWord} (do not use this word anywhere else).`
  );
}

export function seededUndeclaredRoutine(input: {
  readonly id: string;
  readonly org: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly createdBy: string;
  readonly prompt: string;
  readonly fireAt: Date;
  readonly now: Date;
}): Routine {
  if (input.id.length === 0 || input.id.includes(":")) {
    throw new Error(`seededUndeclaredRoutine: routine id "${input.id}" must be non-empty and carry no ":" — the permission key grammar splits on it`);
  }
  if (!(input.fireAt.getTime() > input.now.getTime())) {
    throw new Error(`seededUndeclaredRoutine: fireAt ${input.fireAt.toISOString()} must be after now ${input.now.toISOString()} — a past one-shot never fires`);
  }
  const at = input.fireAt.toISOString();
  return {
    id: input.id,
    org: input.org,
    surfaceKey: `slack/${input.teamId}/${input.channelId}`,
    target: { channelId: input.channelId },
    trigger: { kind: "once", at },
    prompt: input.prompt,
    createdBy: input.createdBy,
    createdAt: input.now.toISOString(),
    status: "active",
    nextRunAt: at,
    consecutiveFailures: 0,
  };
}

export function routineNeverFired(r: Pick<Routine, "status" | "nextRunAt">): boolean {
  return r.status === "active" && typeof r.nextRunAt === "string" && r.nextRunAt.length > 0;
}

export interface RoutineConnectorArmOutcome {
  readonly arm: "A" | "B";
  readonly error?: unknown;
}

export function routineConnectorArmVerdict(outcomes: readonly RoutineConnectorArmOutcome[]): RoutineConnectorArmOutcome | undefined {
  const rank = (error: unknown): number => {
    const name = error instanceof Error ? error.name : "";
    if (name === "ScenarioSkip") return 1;
    if (name === "FixtureMissing") return 2;
    return 3;
  };
  let chosen: RoutineConnectorArmOutcome | undefined;
  for (const o of outcomes) {
    if (!("error" in o) || o.error === undefined) continue;
    if (chosen === undefined || rank(o.error) > rank(chosen.error)) chosen = o;
  }
  return chosen;
}
