import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { defineTool } from "eve/tools";
import type { ApprovalPolicy } from "eve/tools/approval";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-connector-approval-reach-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
process.env.OE_PLATFORM = "slack";
_setDeploymentIdentityForTest({ org: undefined });

let passed = 0;
function fail(label: string): never {
  console.error(`✗ ${label}`);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}
function ok(cond: boolean, label: string): void {
  if (!cond) fail(label);
  passed++;
}
function eq<T>(actual: T, expected: T, label: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

const require_ = createRequire(import.meta.url);
const distSrc = join(dirname(require_.resolve("eve/package.json")), "dist", "src");
const load = async <T>(...rel: readonly string[]): Promise<T> => (await import(pathToFileURL(join(distSrc, ...rel)).href)) as T;

const { resolveConnectionDefinition } = await load<{
  resolveConnectionDefinition: (definition: unknown, moduleMap: unknown, nodeId: string) => Promise<Record<string, unknown>>;
}>("runtime", "resolve-connection.js");
const { ConnectionRegistryImpl } = await load<{
  ConnectionRegistryImpl: new (connections: readonly unknown[]) => { getConnectionApproval(name: string): unknown };
}>("runtime", "connections", "registry.js");
const { buildToolSetFromDefinitions, buildToolApproval } = await load<{
  buildToolSetFromDefinitions: (input: unknown) => Record<string, unknown>;
  buildToolApproval: (toolSet: unknown) => (call: { toolCall: { toolName: string; input: unknown; toolCallId: string } }) => Promise<unknown>;
}>("harness", "tools.js");
const { ContextContainer, contextStorage } = await load<{
  ContextContainer: new () => { set(key: unknown, value: unknown): unknown };
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
}>("context", "container.js");
const { SessionKey } = await load<{ SessionKey: unknown }>("context", "keys.js");

async function resolveThroughEve(namespace: unknown, url: string): Promise<Record<string, unknown>> {
  const definition = {
    connectionName: "notion",
    description: "reachability probe",
    logicalPath: "agent/connections/notion.ts",
    protocol: "mcp",
    sourceId: "reach-source",
    url,
  };
  return await resolveConnectionDefinition(definition, { nodes: { root: { modules: { "reach-source": namespace } } } }, "root");
}

console.log("1. eve's connection resolver, measured on two synthetic modules:");
{
  const policy = (): string => "user-approval";
  const asFunction = await resolveThroughEve({ default: { url: "https://example.invalid/mcp", approval: policy } }, "https://example.invalid/mcp");
  ok(typeof asFunction.approval === "function", "a FUNCTION approval survives eve's connection resolver");

  const asConfiguration = await resolveThroughEve(
    { default: { url: "https://example.invalid/mcp", approval: { request: policy, response: () => ({ status: "allowed" }) } } },
    "https://example.invalid/mcp",
  );
  ok(asConfiguration.approval === undefined, "an approval CONFIGURATION is DROPPED — silently, with no diagnostic (the OPE-1218 defect)");
}

console.log("2. the shipped notion connection through the same resolver:");

const { registerSettings, resetSettingsForTest } = await import("../agent/settings/settings.js");
registerSettings({ connectors: { opTiering: true } });

const notionNamespace = await import("../agent/connections/notion.js");
const notionConnection = (notionNamespace as unknown as { default: Record<string, unknown> }).default;
ok(typeof notionConnection.approval === "function", "the notion connection AUTHORS a bare request policy");

const resolvedNotion = await resolveThroughEve(notionNamespace, notionConnection.url as string);
ok(typeof resolvedNotion.approval === "function", "…and eve's resolver KEEPS it (RED before OPE-1218: dropped)");

const registry = new ConnectionRegistryImpl([resolvedNotion]);
const connectionApproval = registry.getConnectionApproval("notion");
ok(typeof connectionApproval === "function", "…so the connection registry answers a policy, not undefined");
ok(registry.getConnectionApproval("not-a-connection") === undefined, "the registry answers undefined for an unknown connection (negative control)");

console.log("3. eve's own tool-set build and approval resolution:");

function mountDiscoveredTool(toolName: string, approval: unknown): unknown {
  const entry = defineTool({
    description: "a discovered connection tool",
    inputSchema: { type: "object" } as never,
    ...(approval === undefined ? {} : { approval: approval as ApprovalPolicy }),
    async execute() {
      return {};
    },
  });
  (entry as { name?: string }).name = toolName;
  return entry;
}

async function eveApprovalVerdict(input: {
  readonly toolName: string;
  readonly approval: unknown;
  readonly sessionId: string;
  readonly toolInput?: unknown;
  readonly approvedTools?: ReadonlySet<string>;
  readonly auth?: unknown;
}): Promise<unknown> {
  const toolSet = buildToolSetFromDefinitions({
    approvedTools: input.approvedTools ?? new Set<string>(),
    capabilities: {},
    tools: [mountDiscoveredTool(input.toolName, input.approval)],
  });
  const decide = buildToolApproval(toolSet);
  const container = new ContextContainer();
  container.set(SessionKey, { sessionId: input.sessionId, turn: {}, ...(input.auth === undefined ? {} : { auth: input.auth }) });
  return await contextStorage.run(container, () =>
    decide({ toolCall: { toolName: input.toolName, input: input.toolInput ?? {}, toolCallId: `call-${input.toolName}` } }),
  );
}

eq(
  await eveApprovalVerdict({ toolName: "notion__notion-create-pages", approval: connectionApproval, sessionId: "reach-write", toolInput: { title: "x" } }),
  "user-approval",
  "3a. a WRITE-tier connector op RAISES the approval card through eve's own resolution",
);

eq(
  await eveApprovalVerdict({ toolName: "notion__notion-search", approval: connectionApproval, sessionId: "reach-read", toolInput: { query: "x" } }),
  "not-applicable",
  "3b. a READ-tier op does NOT prompt (negative control)",
);

{
  const preFixNamespace = {
    default: { ...notionConnection, approval: { request: notionConnection.approval, response: () => ({ status: "allowed" }) } },
  };
  const preFixResolved = await resolveThroughEve(preFixNamespace, notionConnection.url as string);
  const preFixRegistry = new ConnectionRegistryImpl([preFixResolved]);
  const preFixApproval = preFixRegistry.getConnectionApproval("notion");
  ok(preFixApproval === undefined, "3c. the pre-fix CONFIGURATION arm still resolves to no policy");
  eq(
    await eveApprovalVerdict({ toolName: "notion__notion-create-pages", approval: preFixApproval, sessionId: "reach-prefix", toolInput: { title: "x" } }),
    undefined,
    "…and eve then answers NO approval for the same write — the silent execution a live run measured",
  );
}

{
  const { recordApprovalRaised } = await import("../agent/access/approval-dedupe.js");
  const toolName = "notion__notion-update-page";
  const toolInput = { page: "p1", text: "hello" };
  const sessionId = "reach-deny";
  eq(
    await eveApprovalVerdict({ toolName, approval: connectionApproval, sessionId, toolInput }),
    "user-approval",
    "3d. the first write ask raises",
  );
  await recordApprovalRaised(sessionId, toolName, toolInput);
  const denied = (await eveApprovalVerdict({ toolName, approval: connectionApproval, sessionId, toolInput })) as { type?: string } | undefined;
  ok(
    typeof denied === "object" && denied !== null && denied.type === "denied",
    "…and a same-fingerprint re-ask is DENIED through eve's own resolution (the deny path)",
  );
  eq(
    await eveApprovalVerdict({ toolName, approval: connectionApproval, sessionId: "reach-deny-other", toolInput }),
    "user-approval",
    "…while another session still raises (negative control on the deny)",
  );
}

{
  const { FIRE_PRINCIPAL_ATTR, FIRE_UNATTENDED_ATTR } = await import("../agent/identity/binding.js");
  const { ROUTINE_MARKER } = await import("../agent/routines/routine.js");
  const fireAuth = {
    current: {
      attributes: {
        [FIRE_PRINCIPAL_ATTR]: "U0CREATOR",
        [FIRE_UNATTENDED_ATTR]: "true",
        [ROUTINE_MARKER.id]: "r-reach",
        [ROUTINE_MARKER.surface]: "s/slack:C0REACH/main",
        [ROUTINE_MARKER.org]: "default",
        team_id: "T0REACH",
        channel_id: "C0REACH",
        channel_type: "channel",
      },
    },
  };
  const fired = (await eveApprovalVerdict({
    toolName: "notion__notion-create-pages",
    approval: connectionApproval,
    sessionId: "reach-unattended",
    toolInput: { title: "x" },
    auth: fireAuth,
  })) as { type?: string; reason?: string } | undefined;
  ok(
    typeof fired === "object" && fired !== null && fired.type === "denied",
    "3e. an UNATTENDED fire's connector WRITE is DENIED through eve's own resolution — the fence is REACHED",
  );
  ok(
    typeof fired?.reason === "string" && fired.reason.includes("unattended run cannot wait on an approval card"),
    "…carrying the approvals plane's ask-unattended sentence to the model",
  );
  eq(
    await eveApprovalVerdict({ toolName: "notion__notion-create-pages", approval: connectionApproval, sessionId: "reach-attended-control", toolInput: { title: "x" } }),
    "user-approval",
    "…while the same write with no fire bag still RAISES (negative control on the fence)",
  );
}

console.log("4. eve's connection-search dynamic still reads the registry:");
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(join(distSrc, "execution", "tools", "connection-search.js"), "utf8");
  const mount = /(\w+)\s*=\s*\w+\.getConnectionApproval\(\w+\)[\s\S]{0,400}?approval:\s*\1\b/.exec(src);
  ok(mount !== null, "the dynamic mounts a discovered tool with `approval:` set from getConnectionApproval");
}

resetSettingsForTest();
await removeTempDir(tmp);
console.log(`\nconnector-approval-reachability: ${passed} assertions passed.`);
