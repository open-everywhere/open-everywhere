process.env.OE_SQLITE_PATH = ":memory:";
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { HookContext } from "eve/hooks";
import {
  candidateConnectionsForDeclarations,
  declaredConnectorToolNames,
  projectDeclaredConnectorOps,
  ROUTINE_DECLARED_OPS_MOUNTED_ACTION,
  type ConnectionCatalogue,
} from "../agent/routines/fire-toolset.js";
import { armDeclaredRoutinePermissions, permissionKindsUnderKey } from "../agent/routines/declared-permissions.js";
import { routinePermissionKey, ROUTINE_MARKER, type Routine } from "../agent/routines/routine.js";
import {
  connectorToolPermissionKind,
  connectorSessionKind,
  routinePermissionAskedMemo,
  routinePermissionDeclinedMemo,
} from "../agent/approvals/session-grant.js";
import {
  SCHEDULE_APP_AUTHENTICATOR,
  SCHEDULE_APP_PRINCIPAL_ID,
  SCHEDULE_APP_PRINCIPAL_TYPE,
} from "../agent/identity/binding.js";
import { CONNECTION_REGISTRY_KEY_NAME, CONNECTION_SEARCH_RESULTS_KEY_NAME, mountDeclaredOps } from "../agent/hooks/fire-toolset.js";
import { CONTRIBUTIONS } from "../agent/contributions.js";
import { declaredAuditActions } from "../agent/audit/action-registry.js";
import { readAudit, type AuditEntry } from "../agent/audit/audit.js";

async function settledRowsFor(org: string): Promise<AuditEntry[]> {
  let stable = 0;
  let last = -1;
  for (let attempt = 0; attempt < 150 && stable < 8; attempt += 1) {
    const rows = await readAudit({ org, action: ROUTINE_DECLARED_OPS_MOUNTED_ACTION });
    if (rows.length === last) stable += 1;
    else {
      stable = 0;
      last = rows.length;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return readAudit({ org, action: ROUTINE_DECLARED_OPS_MOUNTED_ACTION });
}

async function settledRows(): Promise<AuditEntry[]> {
  return await settledRowsFor("default");
}

let failures = 0;
function ok(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${label}`);
}

const CONNECTION = "notion";
const OP = "notion-create-pages";
const QUALIFIED = `${CONNECTION}__${OP}`;

const NOTION: ConnectionCatalogue = {
  connection: CONNECTION,
  ops: [
    { name: OP, description: "Create one or more Notion pages.", inputSchema: { type: "object", properties: { pages: { type: "array" } } } },
    { name: "notion-search", description: "Search the workspace." },
  ],
};

console.log("§1 the projection");
{
  const one = projectDeclaredConnectorOps({ declared: [QUALIFIED], catalogues: [NOTION] });
  ok(one.mount.length === 1, "a declared op the connection advertises is mounted");
  ok(one.mount[0]?.qualifiedName === QUALIFIED, "…under the qualified name the declaration spelled and the model calls");
  ok(one.mount[0]?.connection === CONNECTION && one.mount[0]?.tool === OP, "…carrying the connection and the op name eve's resolver reads");
  ok(one.mount[0]?.description === "Create one or more Notion pages.", "…and the connection's own description, which is the whole of what the search would have handed the model");
  ok(one.mount[0]?.inputSchema !== undefined, "…and the advertised input schema, so the model is not asked to guess the arguments");
  ok(one.unresolved.length === 0, "nothing unresolved");

  const missing = projectDeclaredConnectorOps({ declared: ["notion__notion-delete-everything"], catalogues: [NOTION] });
  ok(missing.mount.length === 0, "🔴 a declaration NO connection advertises mounts nothing — the projection never invents an operation");
  ok(missing.unresolved[0] === "notion__notion-delete-everything", "…and it is reported unresolved, so the row says which declaration resolved to nothing");

  const ambiguous = projectDeclaredConnectorOps({
    declared: ["a__b__c"],
    catalogues: [
      { connection: "a", ops: [{ name: "b__c", description: "the inner one" }] },
      { connection: "a__b", ops: [{ name: "c", description: "the outer one" }] },
    ],
  });
  ok(ambiguous.mount.length === 0, "🔴 two connections composing ONE qualified name mount NEITHER — an ambiguous declaration is never resolved to a guess");
  ok(ambiguous.unresolved[0] === "a__b__c", "…and the ambiguity is reported, not swallowed");

  const split = projectDeclaredConnectorOps({
    declared: ["a__only-inner", "a__b__only-outer"],
    catalogues: [
      { connection: "a", ops: [{ name: "only-inner", description: "inner" }] },
      { connection: "a__b", ops: [{ name: "only-outer", description: "outer" }] },
    ],
  });
  ok(split.mount.length === 2, "a connection slug CONTAINING `__` still resolves — nothing splits the name, both sides compose it");
  ok(split.mount[1]?.connection === "a__b", "…and the op belonging to the `__`-bearing slug is attributed to it, not to its head");

  const already = projectDeclaredConnectorOps({ declared: [QUALIFIED], catalogues: [NOTION], alreadyProjected: [QUALIFIED] });
  ok(already.mount.length === 0, "an op a real search already put in the slot is not mounted again — the row would claim a mount that changed nothing");
  ok(already.unresolved.length === 0, "…and it is not reported unresolved either: it IS resolved, by the search");

  const unreadable = projectDeclaredConnectorOps({ declared: [QUALIFIED], catalogues: [{ connection: CONNECTION, ops: [] }] });
  ok(unreadable.mount.length === 0, "an unreadable catalogue (no ops) mounts nothing — the fire falls back to searching, exactly as before this ticket");

  ok(candidateConnectionsForDeclarations([QUALIFIED], [CONNECTION, "linear", "github"]).join(",") === CONNECTION, "🔴 only the connection a declaration could name is read — a catalogue read is a live call, and a fire must not pay one per connected connector");
  ok(candidateConnectionsForDeclarations([QUALIFIED], ["linear"]).length === 0, "…and a deployment whose connections match no declaration reads none at all");
}

console.log("§2 the live permission kinds are what drive the projection");
{
  ok(declaredConnectorToolNames([connectorToolPermissionKind(QUALIFIED)]).join(",") === QUALIFIED, "a live per-tool permission row yields its qualified tool name");
  ok(declaredConnectorToolNames(["pr.open"]).length === 0, "🔴 `pr.open` names no connector tool, so it projects nothing");
  ok(declaredConnectorToolNames([connectorSessionKind(CONNECTION)]).length === 0, "🔴 an inert LEGACY per-connector row projects nothing — it lifts no tool on any code path, so mounting one would hand the fire a tool no row permits");
  ok(
    declaredConnectorToolNames([routinePermissionAskedMemo(connectorToolPermissionKind(QUALIFIED))]).length === 0,
    "🔴 the permission card's ASKED marker projects nothing — a card posted for a permission is not the permission",
  );
  ok(
    declaredConnectorToolNames([routinePermissionDeclinedMemo(connectorToolPermissionKind(QUALIFIED))]).length === 0,
    "🔴 and a human's DECLINE projects nothing — the one direction this plane must never fail in",
  );
  ok(
    declaredConnectorToolNames([connectorToolPermissionKind(QUALIFIED), connectorToolPermissionKind(QUALIFIED)]).length === 1,
    "a repeated kind yields one name",
  );
}

console.log("§3 the hook writes eve's own discovered-result slot");

const ORG = "default";
const routine: Pick<Routine, "id" | "promptGeneration"> = { id: "rtn_2135", promptGeneration: 3 };
const permissionKey = routinePermissionKey(routine);

{
  const written = await armDeclaredRoutinePermissions({
    org: ORG,
    routine,
    declared: [`tool:${QUALIFIED}`],
    grantedBy: "U_HUMAN",
    tainted: false,
    nowIso: new Date().toISOString(),
  });
  ok(written.includes(connectorToolPermissionKind(QUALIFIED)), "the arming click wrote the per-tool row this projection reads");
  const kinds = await permissionKindsUnderKey(ORG, permissionKey, new Date().toISOString());
  ok(kinds.includes(connectorToolPermissionKind(QUALIFIED)), "🔴 the STAMPED-KEY reader finds it — a fire carries its key, never the routine row");
}

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
interface EveContainer {
  get(key: { readonly name: string }): unknown;
  set(key: { readonly name: string }, value: unknown): unknown;
}
const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href)) as {
  ContextContainer: new () => EveContainer;
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
};

async function inSession(fn: (container: EveContainer) => Promise<void>): Promise<void> {
  const container = new ContextContainer();
  await contextStorage.run(container, () => fn(container));
}

function registry(catalogues: readonly ConnectionCatalogue[], throwFor?: string) {
  return {
    getConnectionNames: () => catalogues.map((c) => c.connection),
    getClient: (name: string) => ({
      getToolMetadata: async () => {
        if (name === throwFor) throw new Error("authorization required");
        return catalogues.find((c) => c.connection === name)?.ops ?? [];
      },
    }),
  };
}

function fireCtx(): HookContext {
  return {
    session: {
      id: "wrun_FIRE",
      auth: {
        current: {
          authenticator: SCHEDULE_APP_AUTHENTICATOR,
          principalId: SCHEDULE_APP_PRINCIPAL_ID,
          principalType: SCHEDULE_APP_PRINCIPAL_TYPE,
          attributes: {
            [ROUTINE_MARKER.id]: routine.id,
            [ROUTINE_MARKER.surface]: "slack/T1/C1",
            [ROUTINE_MARKER.org]: ORG,
            [ROUTINE_MARKER.permissionKey]: permissionKey,
          },
        },
      },
    },
  } as unknown as HookContext;
}

function seatCtx(): HookContext {
  return {
    session: { id: "wrun_SEAT", auth: { current: { authenticator: "slack", principalId: "U_HUMAN", principalType: "user", attributes: {} } } },
  } as unknown as HookContext;
}

{
  await inSession(async (store) => {
    store.set({ name: CONNECTION_REGISTRY_KEY_NAME }, registry([NOTION]));

    const outcome = await mountDeclaredOps(fireCtx());
    ok(outcome?.mounted.join(",") === QUALIFIED, "🔴 THE POINT OF THE TICKET: a fire whose declared permission names an op mounts that op");
    const rows = store.get({ name: CONNECTION_SEARCH_RESULTS_KEY_NAME }) as readonly Record<string, unknown>[] | undefined;
    ok(Array.isArray(rows) && rows.length === 1, "…by writing eve's OWN discovered-result slot, which eve's resolver reads to build the tool");
    ok(rows?.[0]?.qualifiedName === QUALIFIED, "…with the qualified name in the field eve's resolver keys on");
    ok(rows?.[0]?.connection === CONNECTION && rows?.[0]?.tool === OP, "…and the two fields eve's resolver closes its execute over");

    const again = await mountDeclaredOps(fireCtx());
    ok(again?.mounted.length === 0, "a second pass in the same session mounts nothing — the slot already holds it");
    const after = store.get({ name: CONNECTION_SEARCH_RESULTS_KEY_NAME }) as readonly unknown[] | undefined;
    ok(after?.length === 1, "…and the slot still holds exactly one row");
  });

  await inSession(async (store) => {
    store.set({ name: CONNECTION_REGISTRY_KEY_NAME }, registry([NOTION]));
    const status = { connection: "linear", description: "Linear", needsAuthorization: true };
    store.set({ name: CONNECTION_SEARCH_RESULTS_KEY_NAME }, [status]);
    await mountDeclaredOps(fireCtx());
    const rows = store.get({ name: CONNECTION_SEARCH_RESULTS_KEY_NAME }) as readonly unknown[];
    ok(rows.length === 2 && rows[0] === status, "🔴 a status row with no `qualifiedName` is KEPT, and the declared op is APPENDED after it");
  });
}

console.log("§3d the audit row");
{
  await inSession(async (store) => {
    store.set({ name: CONNECTION_REGISTRY_KEY_NAME }, registry([NOTION]));
    const hook = (await import("../agent/hooks/fire-toolset.js")).default;
    const arm = ((hook as { events?: Record<string, unknown> }).events ?? {})["turn.started"] as (event: unknown, ctx: HookContext) => Promise<void>;
    ok(typeof arm === "function", "🔴 the hook BINDS `turn.started` — a body nothing dispatches to mounts nothing, and no other assertion here would notice");
    await arm({ type: "turn.started", data: {} }, fireCtx());
    const rows = await settledRows();
    ok(rows.length === 1, "one row for one fire that mounted");
    ok((rows[0]?.detail as Record<string, unknown>).mounted?.toString() === QUALIFIED, "…naming the operation the fire now holds");
    ok((rows[0]?.detail as Record<string, unknown>).unresolved === undefined, "…and no `unresolved` field when everything resolved");
    await arm({ type: "turn.started", data: {} }, fireCtx());
    ok((await settledRows()).length === 1, "a second turn of the same fire files no second row");
  });

  await inSession(async (store) => {
    store.set({ name: CONNECTION_REGISTRY_KEY_NAME }, registry([NOTION], CONNECTION));
    const hook = (await import("../agent/hooks/fire-toolset.js")).default;
    const arm = ((hook as { events?: Record<string, unknown> }).events ?? {})["turn.started"] as (event: unknown, ctx: HookContext) => Promise<void>;
    await arm({ type: "turn.started", data: {} }, fireCtx());
    const after = await settledRows();
    ok(after.length === 2, "an unresolved declaration files its own row, so an operator can see the catalogue was unreadable");
    const miss = after.find((r) => (r.detail as Record<string, unknown>).unresolved !== undefined);
    ok((miss?.detail as Record<string, unknown> | undefined)?.unresolved?.toString() === QUALIFIED, "…naming which declaration resolved to nothing");
    await arm({ type: "turn.started", data: {} }, fireCtx());
    ok((await settledRows()).length === 2, "🔴 and it is filed ONCE per session — an unchanged outcome does not re-file on every turn of a long fire");
  });

  const acme: Pick<Routine, "id" | "promptGeneration"> = { id: "rtn_ACME", promptGeneration: 1 };
  await armDeclaredRoutinePermissions({
    org: "acme",
    routine: acme,
    declared: [`tool:${QUALIFIED}`],
    grantedBy: "U_HUMAN",
    tainted: false,
    nowIso: new Date().toISOString(),
  });
  await inSession(async (store) => {
    store.set({ name: CONNECTION_REGISTRY_KEY_NAME }, registry([NOTION]));
    const other = fireCtx() as unknown as { session: { auth: { current: { attributes: Record<string, string> } } } };
    other.session.auth.current.attributes[ROUTINE_MARKER.org] = "acme";
    other.session.auth.current.attributes[ROUTINE_MARKER.permissionKey] = routinePermissionKey(acme);
    const hook = (await import("../agent/hooks/fire-toolset.js")).default;
    const arm = ((hook as { events?: Record<string, unknown> }).events ?? {})["turn.started"] as (event: unknown, ctx: HookContext) => Promise<void>;
    await arm({ type: "turn.started", data: {} }, other as unknown as HookContext);
    const inAcme = await settledRowsFor("acme");
    ok(inAcme.length === 1, "🔴 the row is filed under the MARKER's org, which is the org the permission rows were read under");
    ok((inAcme[0]?.detail as Record<string, unknown>).mounted?.toString() === QUALIFIED, "…naming the operation that mounted");
    const inDefault = await settledRows();
    ok(inDefault.every((r) => (r.detail as Record<string, unknown>).mounted?.toString() !== QUALIFIED || r.org === "default"), "…and the partition's org did not capture it");
    ok(inDefault.length === 2, "🔴 the `default` tenant gained NO row — so a reader of one tenant's log cannot see another tenant's fire");
  });
}

console.log("§3b the negative controls");
{
  await inSession(async (store) => {
    store.set({ name: CONNECTION_REGISTRY_KEY_NAME }, registry([NOTION]));
    const outcome = await mountDeclaredOps(seatCtx());
    ok(outcome === undefined, "🔴 an ordinary member turn mounts nothing — this projection exists for the unattended fire, and a seat has a person who can ask");
    ok(store.get({ name: CONNECTION_SEARCH_RESULTS_KEY_NAME }) === undefined, "…and the slot is untouched, so §3 was not a free pass");
  });

  await inSession(async (store) => {
    store.set({ name: CONNECTION_REGISTRY_KEY_NAME }, registry([NOTION]));
    const bare = fireCtx() as unknown as { session: { auth: { current: { attributes: Record<string, string> } } } };
    bare.session.auth.current.attributes[ROUTINE_MARKER.permissionKey] = routinePermissionKey({ id: "rtn_OTHER", promptGeneration: 1 });
    const outcome = await mountDeclaredOps(bare as unknown as HookContext);
    ok(outcome === undefined, "a fire that declared nothing mounts nothing");
    ok(store.get({ name: CONNECTION_SEARCH_RESULTS_KEY_NAME }) === undefined, "…and writes no slot");
  });

  await inSession(async (store) => {
    store.set({ name: CONNECTION_REGISTRY_KEY_NAME }, registry([NOTION], CONNECTION));
    const outcome = await mountDeclaredOps(fireCtx());
    ok(outcome?.mounted.length === 0, "🔴 a catalogue read that THROWS mounts nothing and does not throw — the fire falls back to `connection_search`");
    ok(outcome?.unresolved.join(",") === QUALIFIED, "…and the declaration is reported unresolved, so an operator can see the catalogue was unreadable");
  });

  await inSession(async (store) => {
    store.set({ name: CONNECTION_REGISTRY_KEY_NAME }, registry([NOTION]));
    const child = fireCtx() as unknown as { channel?: unknown };
    child.channel = { continuationToken: "subagent:wrun_FIRE:call_ABC" };
    const outcome = await mountDeclaredOps(child as unknown as HookContext);
    ok(outcome === undefined, "🔴 a fire's DELEGATED CHILD mounts nothing — it inherits the fire's auth bag and its permission key, so only the skip keeps this projection about the fire session");
    ok(store.get({ name: CONNECTION_SEARCH_RESULTS_KEY_NAME }) === undefined, "…and writes no slot of its own");
  });

  await inSession(async (store) => {
    store.set({
      name: CONNECTION_REGISTRY_KEY_NAME,
    }, {
      getConnectionNames: () => [CONNECTION],
      getClient: () => ({ getToolMetadata: () => new Promise<never>(() => undefined) }),
    });
    const startedAt = Date.now();
    const outcome = await mountDeclaredOps(fireCtx(), 25);
    ok(outcome?.mounted.length === 0 && outcome?.unresolved.join(",") === QUALIFIED, "🔴 a catalogue read that NEVER ANSWERS resolves to UNRESOLVED instead of hanging the fire's turn");
    ok(Date.now() - startedAt < 2_000, "…and it returns on the budget, not on the transport's own timeout");
  });

  const slowRegistry = {
    getConnectionNames: () => [CONNECTION],
    getClient: () => ({ getToolMetadata: () => new Promise<readonly unknown[]>((resolve) => setTimeout(() => resolve(NOTION.ops), 120)) }),
  };
  await inSession(async (store) => {
    store.set({ name: CONNECTION_REGISTRY_KEY_NAME }, slowRegistry);
    const generous = await mountDeclaredOps(fireCtx(), 2_000);
    ok(generous?.mounted.join(",") === QUALIFIED, "a catalogue that answers INSIDE the budget mounts");
  });
  await inSession(async (store) => {
    store.set({ name: CONNECTION_REGISTRY_KEY_NAME }, slowRegistry);
    const tight = await mountDeclaredOps(fireCtx(), 10);
    ok(tight?.mounted.length === 0, "🔴 and the SAME catalogue outside the budget does not — the bound really binds");
  });

  const outside = await mountDeclaredOps(fireCtx());
  ok(outside === undefined, "no eve context ⇒ no mount, no throw");
}

console.log("§3c the audit action is declared");
{
  ok(
    declaredAuditActions().includes(ROUTINE_DECLARED_OPS_MOUNTED_ACTION),
    "🔴 the row's action is declared in the audit-action registry — an undeclared action is a row nobody asserts losing",
  );
}

console.log("§4 eve still names both context keys, and still mounts from the slot");
{
  const search = readFileSync(join(eveRoot, "dist/src/execution/tools/connection-search.js"), "utf8");
  ok(
    search.includes(`ContextKey(\`${CONNECTION_SEARCH_RESULTS_KEY_NAME}\``),
    `🔴 eve still registers the \`${CONNECTION_SEARCH_RESULTS_KEY_NAME}\` context key — the slot this seam seeds is not on eve's exports map, so a rename must red HERE rather than silently mount nothing`,
  );
  ok(
    search.includes("resolveConnectionSearchDynamicTools"),
    "…and the resolver that turns those rows into callable tools still exists under that name",
  );
  ok(
    /ConnectionSearchResultsKey\)\?\?\[\]/.test(search) || search.includes("ConnectionSearchResultsKey)??[]"),
    "…and it still READS the slot to decide which connector tools to mount, which is the whole mechanism this ticket uses",
  );
  ok(
    /qualifiedName:qualifiedConnectionToolName\(/.test(search),
    "…and a row it writes still carries `qualifiedName` composed as `<connection>__<tool>`, which is the shape §1 asserts",
  );
  const key = readFileSync(join(eveRoot, "dist/src/context/providers/connection-key.js"), "utf8");
  ok(
    key.includes(`ContextKey(\`${CONNECTION_REGISTRY_KEY_NAME}\``),
    `🔴 eve still registers the \`${CONNECTION_REGISTRY_KEY_NAME}\` key — the catalogue read reaches the registry through it`,
  );
  const container = readFileSync(join(eveRoot, "dist/src/context/container.js"), "utf8");
  ok(
    container.includes("_durableValues.set(e.name,n)"),
    "🔴 eve's context container still keys every value by the key's `name` STRING — that is what lets this seam address a framework slot it cannot import",
  );
  const state = readFileSync(join(eveRoot, "dist/src/public/definitions/state.js"), "utf8");
  ok(
    state.includes("RESERVED_STATE_NAME_PREFIX"),
    "…and `defineState` still REFUSES an `eve.` name, which is why the public seam cannot reach this slot and the structural key exists at all",
  );
}

console.log("§5 the hook is declared and mounted");
{
  const declared = CONTRIBUTIONS.contributions.filter((c) => c.kind === "hook" && c.module === "agent/hooks/fire-toolset.js");
  ok(declared.length === 1, "the hook is declared once in contributions.ts");
  const lock = JSON.parse(readFileSync(new URL("../../../roster.lock.json", import.meta.url), "utf8")) as {
    packages: Record<string, { contributions: Record<string, string> }>;
  };
  ok(
    lock.packages["@open-everywhere/core"]?.contributions["hook/fire-toolset"] === "mounted",
    "🔴 the roster MOUNTS it — without that line the hook is dead in production while every assertion above passes",
  );
}

console.log(failures === 0 ? "\nall green" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
