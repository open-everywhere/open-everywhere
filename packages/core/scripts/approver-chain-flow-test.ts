// proves: routine.policy.add

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-chain-flow-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });

const { registerConfig } = await import("../agent/access/config.js");
const { requestApproval } = await import("../agent/approvals/flow.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const telemetryHook = (await import("../agent/hooks/telemetry.js")).default;

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  passed++;
}

registerConfig({
  loadBundles: () => [
    {
      name: "org-policy",
      approvers: [
        {
          name: "no-frozen-deletes",
          approve: (req: { readonly domain?: string; readonly action?: string }) =>
            req.action === "skill.delete" && req.domain === "frozen" ? "deny" : undefined,
        },
        {
          name: "fastlane-lower",
          approve: (req: { readonly domain?: string; readonly action?: string }) =>
            req.action === "skill.delete" && req.domain === "fastlane" ? "allow" : undefined,
        },
        {
          name: "hookfast-lower",
          approve: (req: { readonly domain?: string; readonly action?: string }) =>
            req.action === "webhook.rotate" && req.domain === "hookfast" ? "allow" : undefined,
        },
        {
          name: "rulefast-lower",
          approve: (req: { readonly domain?: string; readonly action?: string }) =>
            req.action === "routine.policy.add" && req.domain === "rulefast" ? "allow" : undefined,
        },
      ],
    },
  ],
  loadBindings: () => [{ bundle: "org-policy", scope: { level: "org" } }],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [
    { name: "bypassed", reach: ["slack/T1/C_BYPASS"], approvalMode: { mode: "DANGEROUSLY_BYPASS" } },
    { name: "lockdown", reach: ["slack/T1/C_LOCK"], approvalMode: { mode: "DENY_ALL" } },
    { name: "frozen", reach: ["slack/T1/C_FROZEN"] },
    { name: "fastlane", reach: ["slack/T1/C_FAST"] },
    { name: "plain", reach: ["slack/T1/C_PLAIN"] },
    { name: "hookfast", reach: ["slack/T1/C_HOOK"] },
    { name: "rulefast", reach: ["slack/T1/C_RULE"] },
  ],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const postCard = async (): Promise<string> => `ts-${Math.random().toString(36).slice(2)}`;
const baseInput = {
  org: "test-org",
  kind: "skill.delete",
  channelId: "C_PLAIN",
  requestedBy: "U_HUMAN",
  threadTs: null,
  chain: { unattended: false },
};
const argsFor = (domain: string) => ({ org: "test-org", domain, name: "ghost-skill", requestedBy: "U_HUMAN" });

async function allPendingActionRows(): Promise<{ id: string; kind: string; scopeKey: string; status: string }[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(process.env.OE_SQLITE_PATH!, { readOnly: true });
  try {
    return db.prepare("SELECT id, kind, scope_key AS scopeKey, status FROM pending_actions").all() as never;
  } finally {
    db.close();
  }
}

class FakeSession {
  private readonly state = new Map<string, unknown>();
  get<T>(key: { name: string }): T | undefined {
    return this.state.get(key.name) as T | undefined;
  }
  has(key: { name: string }): boolean {
    return this.state.has(key.name);
  }
  require<T>(key: { name: string }): T {
    if (!this.has(key)) throw new Error(`missing ${key.name}`);
    return this.get(key) as T;
  }
  set<T>(key: { name: string }, v: T | ((c: T | undefined) => T)): T {
    const next = typeof v === "function" ? (v as (c: T | undefined) => T)(this.get(key)) : v;
    this.state.set(key.name, next);
    return next;
  }
  ensure<T>(key: { name: string }, create: () => T): T {
    return this.has(key) ? this.require(key) : this.set(key, create());
  }
  clearVirtualContext(): void {}
  setVirtualContext(): void {}
  *entries(): Generator<readonly [unknown, unknown]> {}
}
function eveContextStorage(): AsyncLocalStorage<unknown> {
  const g = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for("eve.context-storage");
  g[key] ??= new AsyncLocalStorage();
  return g[key] as AsyncLocalStorage<unknown>;
}
async function inTurn<T>(sessionId: string, turnId: string, fn: () => T | Promise<T>): Promise<T> {
  return eveContextStorage().run(new FakeSession(), async () => {
    const events = telemetryHook.events as unknown as Record<string, (e: unknown, c: unknown) => unknown>;
    const started = events["turn.started"];
    if (typeof started !== "function") throw new Error("hooks/telemetry.ts does not bind turn.started");
    await started({ type: "turn.started", data: { turnId } }, { session: { id: sessionId } });
    return fn();
  });
}

type Row = { action: string; detail?: Record<string, unknown> };
async function rowsFor(action: string): Promise<Row[]> {
  return (await readAudit({ org: "test-org" })).filter((r) => r.action === action) as Row[];
}

async function chainRowFor(key: Record<string, unknown>): Promise<Record<string, unknown>> {
  const matches = (await rowsFor("approval.chain")).filter((r) => Object.entries(key).every(([k, v]) => (r.detail ?? {})[k] === v));
  if (matches.length !== 1) {
    throw new Error(`chainRowFor(${JSON.stringify(key)}) matched ${matches.length} rows — the selector must name exactly one call`);
  }
  return matches[0]!.detail ?? {};
}

{
  const res = await requestApproval(
    { ...baseInput, args: argsFor("plain"), scopeKey: "slack/T1/C_PLAIN", domain: "plain" },
    { postCard },
  );
  ok(res.autoApproved === undefined && typeof res.id === "string", "parity: an unlowered gated verb still cards");
  const row = (await getOperationalStore().listPendingActions("test-org")).find((r) => r.id === res.id);
  ok(row !== undefined && row.status === "pending", "parity: a pending row awaits the click, exactly as before");
  const chainRows = await rowsFor("approval.chain");
  ok(chainRows.length === 1, "parity: the resolution wrote its approval.chain row");
  const d = await chainRowFor({ action: "skill.delete", domain: "plain", unattended: false });
  ok(d.verdict === "ask" && d.registryVerdict === "ask" && d.resolvedBy === "registry", "parity: the row shows ask, resolved by the registry");
  ok(Array.isArray(d.elements) && (d.elements as unknown[]).length >= 5, "parity: every element's verdict is on the row");
}

{
  let threw = "";
  try {
    await requestApproval({ ...baseInput, args: argsFor("frozen"), scopeKey: "slack/T1/C_FROZEN", domain: "frozen", channelId: "C_FROZEN" }, { postCard });
  } catch (e) {
    threw = String(e);
  }
  ok(threw.includes("DENIED by the approver chain") && threw.includes("custom:no-frozen-deletes"), "deny: the propose throws, naming the denying element");
  const rows = (await getOperationalStore().listPendingActions("test-org")).filter((r) => r.scopeKey === "slack/T1/C_FROZEN");
  ok(rows.length === 0, "deny: NO pending row was minted (fail fast, nothing to reconcile)");
  const d = await chainRowFor({ action: "skill.delete", domain: "frozen", unattended: false });
  ok(d.verdict === "deny" && d.registryVerdict === "ask" && d.denyAbsolute === true, "deny: the row carries BOTH verdicts + the absolute-deny mark");
}

{
  const res = await requestApproval({ ...baseInput, args: argsFor("fastlane"), scopeKey: "slack/T1/C_FAST", domain: "fastlane", channelId: "C_FAST" }, { postCard });
  ok(res.autoApproved !== undefined && res.autoApproved.resolvedBy === "custom:fastlane-lower", "allow: the propose auto-approved, naming the lowering element");
  ok(res.autoApproved!.outcome.includes("already gone"), "allow: the kind's REAL execute ran the frozen args (harmless noop target)");
  const decided = await getOperationalStore().getPendingAction("test-org", res.id);
  ok(decided !== null && decided.status === "approved", "allow: the wedge row exists, status approved");
  ok(decided!.decidedBy === "chain:custom:fastlane-lower", "allow: decidedBy is the chain element, never a human's id");
  const auto = await rowsFor("approval.autoapproved");
  ok(auto.length === 1 && (auto[0]!.detail ?? {}).resolvedBy === "custom:fastlane-lower", "allow: the approval.autoapproved row records the lowering");
}

const rotateArgs = {
  org: "test-org",
  args: { org: "test-org", hookId: "ci-status", posture: "read-only", surfaceKey: "slack/T1/C_HOOK", requestedBy: "U_HUMAN", platform: "slack", channelId: "C_HOOK" },
  kind: "webhook.rotate",
  scopeKey: "slack/T1/C_HOOK",
  domain: "hookfast",
  channelId: "C_HOOK",
  requestedBy: "U_HUMAN",
  threadTs: null,
};
{
  const res = await requestApproval({ ...rotateArgs, chain: { unattended: false } }, { postCard });
  ok(res.autoApproved === undefined && typeof res.id === "string", "floor: webhook.rotate under the SAME lowering that auto-approves skill.delete instead CARDS");
  const row = (await getOperationalStore().listPendingActions("test-org")).find((r) => r.id === res.id);
  ok(row !== undefined && row.status === "pending", "floor: a pending row awaits a human's click — the mint has NOT happened");
  const auto = await rowsFor("approval.autoapproved");
  ok(!auto.some((r) => (r.detail ?? {}).kind === "webhook.rotate"), "floor: no approval.autoapproved row was ever written for webhook.rotate — execute() did not run");
  const d = (await chainRowFor({ action: "webhook.rotate", unattended: false })) as { verdict?: string; registryVerdict?: string; transforms?: { name: string }[] };
  ok(d.verdict === "ask" && d.registryVerdict === "ask", "floor: the chain row shows ask despite the operator's lowering element existing");
  ok((d.transforms ?? []).some((t) => t.name === "beneficiary-clicker-floor"), "floor: the row names the arrow that refused the lowering — queryable, like every other transform");
}

{
  let threw = "";
  try {
    await requestApproval({ ...rotateArgs, chain: { unattended: true } }, { postCard });
  } catch (e) {
    threw = String(e);
  }
  ok(threw.includes("DENIED") && threw.includes("ask-unattended"), "floor/unattended: a lowered beneficiary-clicker kind on an unwatched run DENIES rather than minting an unclickable card");
  const d = (await chainRowFor({ action: "webhook.rotate", unattended: true })) as { verdict?: string; transforms?: { name: string }[] };
  ok(
    d.verdict === "deny" && (d.transforms ?? []).map((t) => t.name).join(",") === "beneficiary-clicker-floor,unattended",
    "floor/unattended: the row shows the floor raising it to ask and unattended then denying that ask — the stage order, visible",
  );
}

{
  let threw = "";
  try {
    await requestApproval(
      { ...baseInput, args: argsFor("plain"), scopeKey: "slack/T1/C_PLAIN", domain: "plain", chain: { unattended: true } },
      { postCard },
    );
  } catch (e) {
    threw = String(e);
  }
  ok(threw.includes("ask-unattended"), "unattended: ask → deny with its reason (no card into an empty room)");
  ok(threw.includes("arm the permission on the routine's creation card"), "unattended: the refusal tells the fire the declared-grant path");
}

{
  const res = await requestApproval({ ...baseInput, args: argsFor("bypassed"), scopeKey: "slack/T1/C_BYPASS", domain: "bypassed", channelId: "C_BYPASS" }, { postCard });
  ok(res.autoApproved !== undefined, "mode: BYPASS auto-approves the gated verb (kills the card)");
  const d = await chainRowFor({ action: "skill.delete", domain: "bypassed", unattended: false });
  const transforms = (d.transforms ?? []) as { name: string }[];
  ok(transforms.some((t) => t.name === "mode:DANGEROUSLY_BYPASS"), "mode: recorded as a TRANSFORM on the row, not an element verdict");
}

{
  let threw = "";
  try {
    await requestApproval(
      { ...baseInput, args: argsFor("frozen"), scopeKey: "slack/T1/C_FROZEN", domain: "frozen", channelId: "C_FROZEN", chain: { unattended: false } },
      { postCard },
    );
  } catch (e) {
    threw = String(e);
  }
  ok(threw.includes("DENIED"), "deny-vs-mode: the operator's written prohibition still refuses");
}

{
  let threw = "";
  try {
    await requestApproval({ ...baseInput, args: argsFor("lockdown"), scopeKey: "slack/T1/C_LOCK", domain: "lockdown", channelId: "C_LOCK" }, { postCard });
  } catch (e) {
    threw = String(e);
  }
  ok(threw.includes("DENIED") && threw.includes("mode-deny-all"), "DENY_ALL: the gated verb denies fast, audited with its reason");
}

{
  const { addRoutine, newPolicyRuleId } = await import("../agent/routines/store.js");
  const RULE_PARTITION = {
    org: "test-org",
    platform: "slack",
    workspace: "T1",
    surface: "C_RULE",
    workspaceKey: "slack/T1",
    surfaceKey: "slack/T1/C_RULE",
    domainKey: "slack/T1/C_RULE",
    key: "slack/T1/C_RULE",
  };
  const RULE_ROUTINE = "r-ope2716-rules";
  await addRoutine(RULE_PARTITION, {
    id: RULE_ROUTINE,
    org: "test-org",
    surfaceKey: "slack/T1/C_RULE",
    target: { channelId: "C_RULE" },
    trigger: { kind: "once", at: new Date(Date.now() + 86_400_000).toISOString() },
    prompt: "summarise the minutes (OPE-2716 fixture routine)",
    createdBy: "U_HUMAN",
    status: "active",
    nextRunAt: new Date(Date.now() + 86_400_000).toISOString(),
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    promptGeneration: 1,
    consecutiveFailures: 0,
  } as never);
  const ruleArgs = (ruleId: string) => ({
    org: "test-org",
    partition: RULE_PARTITION,
    surfaceKey: "slack/T1/C_RULE",
    routineId: RULE_ROUTINE,
    description: "every weekday at 09:00",
    ruleId,
    rule: `Never post before 09:00 UTC (${ruleId}).`,
    why: "the 2026-08-13 run woke the channel at 03:12.",
    source: "human" as const,
    countBefore: 0,
    requestedBy: "U_HUMAN",
  });
  const ruleInput = (ruleId: string) => ({
    org: "test-org",
    kind: "routine.policy.add",
    args: ruleArgs(ruleId),
    scopeKey: "slack/T1/C_RULE",
    domain: "rulefast",
    requestedBy: "U_HUMAN",
    channelId: "C_RULE",
    threadTs: null,
  });
  const attendedRows = async (): Promise<Record<string, unknown>[]> =>
    (await rowsFor("approval.chain"))
      .map((r) => r.detail ?? {})
      .filter((d) => d["action"] === "routine.policy.add" && d["unattended"] === false && d["domain"] === "rulefast");
  const outcomes: string[] = [];
  const ruleIds = { tainted: newPolicyRuleId(), clean: newPolicyRuleId() };
  for (const [label, tainted] of [["tainted", true], ["clean", false]] as const) {
    const ruleId = ruleIds[label];
    const before = (await attendedRows()).length;
    const res = await requestApproval({ ...ruleInput(ruleId), chain: { unattended: false, tainted } }, { postCard });
    ok(res.autoApproved !== undefined && res.autoApproved.resolvedBy === "custom:rulefast-lower", `taint/${label}: the operator's lowering auto-approves (OPE-2716)`);
    const rows = await attendedRows();
    ok(rows.length === before + 1, `taint/${label}: the propose wrote exactly one approval.chain row`);
    for (const d of rows) {
      ok(d["verdict"] === "allow" && Array.isArray(d["transforms"]) && (d["transforms"] as unknown[]).length === 0, `taint/${label}: the row shows allow with NO transform`);
      ok(!("tainted" in d) && !("taintKinds" in d) && !("taintMode" in d), `taint/${label}: the row carries no taint field`);
    }
    const d = rows[0]!;
    outcomes.push(JSON.stringify({ verdict: d["verdict"], resolvedBy: d["resolvedBy"], transforms: d["transforms"] }));
  }
  ok(outcomes[0] === outcomes[1], "taint: the tainted propose and its clean control resolve identically");
  const armed = (await rowsFor("routine.policy.add")).map((r) => (r.detail ?? {})["ruleId"]);
  ok(armed.includes(ruleIds.tainted) && armed.includes(ruleIds.clean), "taint: both lowered rules really ARMED — a routine.policy.add row for each");

  {
    let threw = "";
    try {
      await requestApproval(
        { ...ruleInput(newPolicyRuleId()), scopeKey: "slack/T1/C_PLAIN", domain: "plain", channelId: "C_PLAIN", chain: { unattended: true, tainted: true } },
        { postCard },
      );
    } catch (e) {
      threw = String(e);
    }
    ok(threw.includes("DENIED") && threw.includes("ask-unattended"), "taint/unattended: an unlowered gated act with nobody watching DENIES");
    ok(!threw.includes("read external content"), "taint/unattended: OPE-2718: …and the refusal names no taint");
    ok(threw.includes("arm the permission on the routine's creation card"), "taint/unattended: OPE-2718: …it gives the ordinary advice to arm the permission");
    const d = (await chainRowFor({ action: "routine.policy.add", unattended: true })) as { verdict?: string; transforms?: { name: string }[] };
    ok(d.verdict === "deny" && (d.transforms ?? []).map((t) => t.name).join(",") === "unattended", "taint/unattended: the row shows the deny by the unattended arrow alone");
  }
}

{
  const res = await requestApproval(
    {
      org: "test-org",
      kind: "session.checkpoint",
      args: { org: "test-org", scopeKey: "slack/T1/C_LOCK", sessionId: "w1" },
      scopeKey: "slack/T1/C_LOCK",
      domain: "lockdown",
      requestedBy: "U_HUMAN",
      channelId: "C_LOCK",
      threadTs: null,
    },
    { postCard },
  );
  ok(res.autoApproved === undefined && typeof res.id === "string", "non-tool kind: session.checkpoint still cards even under DENY_ALL — the chain governs tool-proposed kinds only");
}

{
  const redeliverInput = {
    ...baseInput,
    args: { org: "test-org", domain: "fastlane", name: "ghost-skill-redelivered", requestedBy: "U_HUMAN" },
    scopeKey: "slack/T1/C_FAST",
    domain: "fastlane",
    channelId: "C_FAST",
  };
  const inOneTurn = await inTurn("sess-A", "turn_0", async () => {
    const first = await requestApproval(redeliverInput, { postCard });
    const again = await requestApproval(redeliverInput, { postCard });
    ok(first.autoApproved !== undefined, "redelivery: the first delivery auto-approves, as the ALLOW leg above does");
    ok(again.autoApproved !== undefined, "redelivery: the second delivery still auto-approves and still runs the act — the fix suppresses a ROW, never an execution");
    ok(again.id === first.id, "🔴 redelivery: and it lands on the SAME wedge id — the id is derived from the turn and the decision, not minted per delivery");
    return first.id;
  });

  const inNextTurn = await inTurn("sess-A", "turn_1", async () => {
    const later = await requestApproval(redeliverInput, { postCard });
    ok(later.autoApproved !== undefined, "redelivery: a later turn's identical propose auto-approves too");
    return later.id;
  });
  ok(inNextTurn !== inOneTurn, "🔴 redelivery: a LATER TURN mints its OWN wedge row — the fix collapses a redelivery, never two real acts");

  const inOtherSession = await inTurn("sess-B", "turn_0", async () => {
    const tomorrow = await requestApproval(redeliverInput, { postCard });
    ok(tomorrow.autoApproved !== undefined, "redelivery: the next fire's identical propose auto-approves too");
    return tomorrow.id;
  });
  ok(
    inOtherSession !== inOneTurn && inOtherSession !== inNextTurn,
    "🔴 redelivery: A DIFFERENT SESSION AT THE SAME TURN ORDINAL MINTS ITS OWN ROW — two nightly fires both report `turn_0`, and the key must not fold them",
  );

  const wedges = (await allPendingActionRows()).filter(
    (r) => r.kind === "skill.delete" && r.scopeKey === "slack/T1/C_FAST" && r.status === "approved" && [inOneTurn, inNextTurn, inOtherSession].includes(r.id),
  );
  ok(wedges.length === 3, `🔴 redelivery: exactly THREE wedge rows for four deliveries across two sessions (got ${wedges.length})`);

  const auto = (await rowsFor("approval.autoapproved")).filter((r) => (r.detail ?? {}).id === inOneTurn);
  ok(auto.length === 2, `🔴 redelivery: both executions in turn A are audited against its one row (got ${auto.length})`);
  const marked = auto.filter((r) => (r.detail ?? {}).wedgeRowReused === true);
  ok(marked.length === 1, "🔴 redelivery: exactly one carries `wedgeRowReused` — the trail states that a row with this id was already there, and nothing more");
  ok(auto.filter((r) => (r.detail ?? {}).wedgeRowReused === undefined).length === 1, "redelivery: and the first does not — the negative control for the flag");
  for (const [label, id] of [["the later turn", inNextTurn], ["the other session", inOtherSession]] as const) {
    const own = (await rowsFor("approval.autoapproved")).filter((r) => (r.detail ?? {}).id === id);
    ok(own.length === 1 && (own[0]!.detail ?? {}).wedgeRowReused === undefined, `🔴 redelivery: ${label}'s execution is audited against its OWN row and is not marked reused`);
  }
}

console.log(`✓ approver-chain-flow: ${passed} assertions — ask parity (card + chain row), operator deny (nothing minted), config lowering (frozen args executed, wedge row decided by the chain), unattended fail-fast, BYPASS-as-transform, deny-survives-bypass, DENY_ALL, the non-tool-kind carve-out, the OPE-310 beneficiary-clicker floor, the OPE-438 taint verdict shift (attended ⇒ card, unattended ⇒ deny naming taint, clean ⇒ unchanged), and the OPE-1348 one-row-per-authorisation-per-turn wedge`);
await removeTempDir(tmp);
