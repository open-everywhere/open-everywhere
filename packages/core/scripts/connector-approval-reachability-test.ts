import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-connector-approval-reach-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
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
  buildToolApproval: (
    toolSet: unknown,
  ) => (call: { toolCall: { toolName: string; input: unknown; toolCallId: string }; messages: readonly unknown[] }) => Promise<unknown>;
}>("harness", "tools.js");
const { ContextContainer, contextStorage } = await load<{
  ContextContainer: new () => { set(key: unknown, value: unknown): unknown };
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
}>("context", "container.js");
const { SessionKey } = await load<{ SessionKey: unknown }>("context", "keys.js");
const { ConnectionRegistryKey } = await load<{ ConnectionRegistryKey: unknown }>("context", "providers", "connection-key.js");
const { resolveConnectionTools } = await load<{
  resolveConnectionTools: () => Record<string, unknown> | null;
}>("execution", "tools", "connection-tools.js");

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

async function eveApprovalVerdict(input: {
  readonly registry: unknown;
  readonly op: string;
  readonly sessionId: string;
  readonly toolInput?: unknown;
  readonly approvedTools?: ReadonlySet<string>;
  readonly auth?: unknown;
}): Promise<unknown> {
  const container = new ContextContainer();
  container.set(SessionKey, { sessionId: input.sessionId, turn: {}, ...(input.auth === undefined ? {} : { auth: input.auth }) });
  container.set(ConnectionRegistryKey, input.registry);
  return await contextStorage.run(container, async () => {
    const mounted = resolveConnectionTools();
    if (mounted === null) fail("eve mounted NO connector tools for a context that holds a connection registry");
    const tools = Object.entries(mounted).map(([name, entry]) => Object.assign(entry as object, { name }));
    const toolSet = buildToolSetFromDefinitions({ approvedTools: input.approvedTools ?? new Set<string>(), tools });
    const decide = buildToolApproval(toolSet);
    return await decide({
      toolCall: {
        toolName: "connection_execute",
        input: { connection: "notion", tool: input.op, input: input.toolInput ?? {} },
        toolCallId: `call-${input.op}`,
      },
      messages: [],
    });
  });
}

{
  const verdict = (await eveApprovalVerdict({ registry, op: "notion-create-pages", sessionId: "reach-write", toolInput: { title: "x" } })) as { type?: string; reason?: string } | undefined;
  ok(
    typeof verdict === "object" && verdict !== null && verdict.type === "denied" && (verdict.reason ?? "").includes("needs a member's approval"),
    `3a. a WRITE-tier connector op is GATED through eve's own resolution: denied, never prompted (got ${JSON.stringify(verdict)})`,
  );
}

eq(
  await eveApprovalVerdict({ registry, op: "notion-search", sessionId: "reach-read", toolInput: { query: "x" } }),
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
    await eveApprovalVerdict({ registry: preFixRegistry, op: "notion-create-pages", sessionId: "reach-prefix", toolInput: { title: "x" } }),
    undefined,
    "…and eve then answers NO approval for the same write — the silent execution a live run measured",
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
    registry,
    op: "notion-create-pages",
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
  const control = (await eveApprovalVerdict({ registry, op: "notion-create-pages", sessionId: "reach-attended-control", toolInput: { title: "x" } })) as { type?: string; reason?: string } | undefined;
  ok(
    typeof control === "object" && control !== null && !(control.reason ?? "").includes("unattended run cannot wait on an approval card"),
    "…while the same write with no fire bag is NOT given the unattended refusal (negative control on the fence)",
  );
}

console.log("4. eve's connector plane mounts two fixed tools, and only connection_execute carries the approval:");
{
  const mountIn = (registry: unknown): Record<string, unknown> | null => {
    const container = new ContextContainer();
    container.set(SessionKey, { sessionId: "reach-mount", turn: {} });
    if (registry !== undefined) container.set(ConnectionRegistryKey, registry);
    return contextStorage.run(container, () => resolveConnectionTools());
  };
  const mounted = mountIn(registry);
  eq(Object.keys(mounted ?? {}).sort(), ["connection_execute", "connection_search"], "4a. the plane is exactly two fixed tools — no per-op `<connection>__<op>` tool");
  const execute = (mounted?.connection_execute ?? {}) as { approval?: unknown };
  const search = (mounted?.connection_search ?? {}) as { approval?: unknown };
  ok(execute.approval !== undefined, "4b. `connection_execute` carries an approval built from the registry's notion policy");
  ok(search.approval === undefined, "…and `connection_search` carries none — it lists tools and runs no op");
  const preFix = new ConnectionRegistryImpl([
    await resolveThroughEve(
      { default: { ...notionConnection, approval: { request: notionConnection.approval, response: () => ({ status: "allowed" }) } } },
      notionConnection.url as string,
    ),
  ]);
  ok(((mountIn(preFix)?.connection_execute ?? {}) as { approval?: unknown }).approval === undefined, "4c. a registry that answers NO policy mounts `connection_execute` with no approval (negative control)");
  ok(mountIn(undefined) === null, "4d. a context with no connection registry mounts no connector tool at all (negative control)");
}

resetSettingsForTest();
await removeTempDir(tmp);
console.log(`\nconnector-approval-reachability: ${passed} assertions passed.`);
