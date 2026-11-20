// proves: AP-EVEAPP-packages-core-agent-connections-notion-ts

/**
 * The connector approval policy is REACHED on eve 1.x. The shipped Notion connection mounts as OE's
 * own deferred connector tools (`connections/connector-mount.ts`), and each tool carries the
 * connection's approval policy. This suite resolves the shipped mount through `seatCut`, mounts the
 * result with eve's real dynamic-tool mount, and asks eve's own approval gate
 * (`harness/tools.js#decideApproval`) about each op. A write op is gated, a read op is not, and an
 * unattended fire's write is refused. A tool with no approval policy runs every op with no gate,
 * which is the negative control.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";
import { setPlatformStandInForTest } from "../agent/identity/binding.js";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-connector-approval-reach-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
delete process.env.DATABASE_URL;
setPlatformStandInForTest("slack");
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

const { contributeTools } = await load<{
  contributeTools(def: { logicalPath: string; slug: string }, value: unknown, ctx: unknown): { live?: Array<Record<string, unknown> & { name: string }> };
}>("definitions", "tools.js");
const { decideApproval } = await load<{
  decideApproval(definition: unknown, call: { callId: string; input: unknown }): Promise<{ denied?: boolean; reason?: string; approval?: unknown } & Record<string, unknown>>;
}>("harness", "tools.js");
const { ContextContainer, contextStorage } = await load<{
  ContextContainer: new () => { set(key: unknown, value: unknown): unknown };
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
}>("context", "container.js");
const { SessionKey } = await load<{ SessionKey: unknown }>("context", "keys.js");

const { fakeMcpServer } = await import("./_fake-mcp-server.js");
const { defineConnectorMount } = await import("../agent/connections/connector-mount.js");
const { resetConnectorCatalogue } = await import("../agent/connections/connector-catalogue.js");
const { seatCut } = await import("../agent/access/seat-cut.js");
const { registerSettings, resetSettingsForTest } = await import("../agent/settings/settings.js");
registerSettings({ connectors: { opTiering: true } });

const DYNAMIC = Symbol.for("eve.dynamic");
const URL_ = "https://mcp.example.test/mcp";
const TOOLS = [
  { name: "notion-search", description: "Search the workspace", annotations: { readOnlyHint: true } },
  { name: "notion-create-pages", description: "Create pages", annotations: { readOnlyHint: false, destructiveHint: false } },
];

interface LiveTool {
  readonly name: string;
  readonly approval?: unknown;
}

type Verdict = Awaited<ReturnType<typeof decideApproval>>;

const appAuth = async () => ({ principalType: "app" as const, async getToken() { return { token: "tok" }; } });

async function mountedOps(mount: unknown, session: { sessionId: string; auth?: unknown }): Promise<Map<string, LiveTool>> {
  const resolveFn = (seatCut("notion", mount) as Record<symbol, unknown>)[DYNAMIC] as (ctx: unknown) => Promise<unknown>;
  const ctx = { callId: "list", session: { id: session.sessionId, turn: { id: "turn-1", sequence: 1 }, auth: session.auth } };
  const value = await resolveFn(ctx);
  const live = (contributeTools({ logicalPath: "agent/tools/notion.ts", slug: "notion" }, value, new ContextContainer()).live ?? []) as unknown as LiveTool[];
  return new Map(live.map((t) => [t.name, t]));
}

async function eveVerdict(tool: LiveTool, input: { sessionId: string; auth?: unknown; toolInput: Record<string, unknown> }): Promise<Verdict> {
  const container = new ContextContainer();
  container.set(SessionKey, { sessionId: input.sessionId, turn: { id: "turn-1", sequence: 1 }, ...(input.auth === undefined ? {} : { auth: input.auth }) });
  return await contextStorage.run(container, () => decideApproval(tool, { callId: `call-${tool.name}-${input.sessionId}`, input: input.toolInput }));
}

const isDenied = (v: Verdict): boolean => v.denied === true;
const reasonOf = (v: Verdict): string => (typeof v.reason === "string" ? v.reason : JSON.stringify(v));
const runsWithNoGate = (v: Verdict): boolean => v.denied !== true && v.approval === undefined && v.status === undefined;

console.log("1. the shipped Notion mount takes the connector approval policy:");
const { NOTION_MOUNT } = await import("../agent/connections/notion.js");
ok(typeof NOTION_MOUNT.approval === "function", "🔴 the shipped Notion spec carries the connector approval policy (mcpConnectionMountSpec sets connectorApprovalPolicy())");
resetConnectorCatalogue();
const server = fakeMcpServer({ tools: TOOLS });
const shipped = defineConnectorMount({ ...NOTION_MOUNT, url: URL_, auth: appAuth as never, client: { fetch: server.fetch } });
const ops = await mountedOps(shipped, { sessionId: "reach-mount" });
eq([...ops.keys()].sort(), ["notion__notion-create-pages", "notion__notion-search"], "eve mounts one deferred tool per listed op, keyed <connection>__<op>");
ok([...ops.values()].every((t) => t.approval !== undefined), "🔴 every mounted op carries an approval policy");

console.log("2. eve's own approval gate, asked about each op:");
{
  const write = await eveVerdict(ops.get("notion__notion-create-pages")!, { sessionId: "reach-write", toolInput: { title: "x" } });
  ok(isDenied(write) && reasonOf(write).includes("needs a member's approval"), `🔴 2a. a WRITE-tier op is GATED through eve's own approval resolution: denied, never run (got ${JSON.stringify(write)})`);
  const read = await eveVerdict(ops.get("notion__notion-search")!, { sessionId: "reach-read", toolInput: { query: "x" } });
  ok(runsWithNoGate(read), `2b. a READ-tier op runs with no gate (negative control, got ${JSON.stringify(read)})`);
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
  const fired = await eveVerdict(ops.get("notion__notion-create-pages")!, { sessionId: "reach-unattended", auth: fireAuth, toolInput: { title: "x" } });
  ok(isDenied(fired), `🔴 2c. an UNATTENDED fire's connector WRITE is DENIED through eve's own approval resolution (got ${JSON.stringify(fired)})`);
  ok(reasonOf(fired).includes("unattended run cannot wait on an approval card"), "…carrying the approvals plane's unattended sentence to the model");
  const control = await eveVerdict(ops.get("notion__notion-create-pages")!, { sessionId: "reach-attended-control", toolInput: { title: "x" } });
  ok(!reasonOf(control).includes("unattended run cannot wait on an approval card"), "…while the same write with no fire bag gets no unattended refusal (negative control on the fence)");
}

console.log("3. negative control: the same op with no policy runs with no gate:");
{
  const stripped: LiveTool = { name: "notion__notion-create-pages" };
  ok(runsWithNoGate(await eveVerdict(stripped, { sessionId: "reach-open", toolInput: { title: "x" } })), "the write op with its approval removed runs with no gate, so 2a measures the policy");
}

resetSettingsForTest();
await removeTempDir(tmp);
console.log(`\nconnector-approval-reachability: ${passed} assertions passed.`);
