import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConsequenceTier } from "../agent/access/consequence.js";
import type { BindableContext } from "../agent/identity/binding.js";
import { overrideSettingsForTest } from "../agent/settings/settings.js";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-window-capability-")), "ops.sqlite3");

overrideSettingsForTest({ delegation: { oneshotAgent: false } });

const { TOOL_CONSEQUENCE } = await import("../agent/access/consequence.js");
const { WINDOW_GATED_TOOLS, withheldFromGrain, resolveWindowGated } = await import("../agent/access/window-gated.js");
const { defineDomain, assertWindowSourcesVouched } = await import("../agent/memory/domain.js");
const { supervisorGrainFor } = await import("../agent/channels/unified-supervisor.js");
const { singleWindowMentionPolicy } = await import("../agent/channels/unified-window.js");
const { isVouchedInternal, registerSurfaces, defineSurface, _resetSurfacesForTest } = await import("../agent/identity/trust.js");
const { windowGrainOf } = await import("../agent/identity/binding.js");
const { dmWindowKey, formatWindowToken, taskWindowId } = await import("../agent/channels/window-key.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};
const noThrow = (fn: () => unknown, label: string) => {
  assert.doesNotThrow(fn, label);
  n++;
};

const withWindowEnv = <T>(fn: () => T): T => {
  overrideSettingsForTest({ window: { topology: true } });
  try {
    return fn();
  } finally {
    overrideSettingsForTest({ window: { topology: false } });
  }
};

const FULL_CAPABILITY_TOOLS = ["checkout_repo", "bash", "web_fetch", "write_file", "open_pull_request", "post_file", "create_skill", "create_routine"] as const;

const isMountedTier = (t: ConsequenceTier) => t === "open" || t === "gate:member";

console.log("P0-a — standing window seat is structurally NARROWED (Stage C flip):");

const gatedModules: Record<string, unknown> = {
  checkout_repo: (await import("../agent/tools/checkout_repo.js")).default,
  open_pull_request: (await import("../agent/tools/open_pull_request.js")).default,
  post_file: (await import("../agent/tools/post_file.js")).default,
  create_skill: (await import("../agent/tools/create_skill.js")).default,
  delete_skill: (await import("../agent/tools/delete_skill.js")).default,
  spawn_thread_session: (await import("../agent/tools/spawn_thread_session.js")).default,
};
const sandboxKit = (await import("../agent/tools/sandbox_tools.js")).default;
const SANDBOX_SIX = ["bash", "glob", "grep", "read_file", "write_file", "web_fetch"] as const;

const grainCtxOf = (grain: "standing" | "task" | "native"): BindableContext => {
  const token =
    grain === "standing"
      ? `unified:${formatWindowToken({ domain: "payments", windowId: "payments", generation: 5 })}`
      : grain === "task"
        ? `unified:${formatWindowToken({ domain: "payments", windowId: taskWindowId("slack/C1", "1720.9"), generation: 5 })}`
        : "cse_example3_native";
  return {
    channel: { kind: "unified", continuationToken: token },
    session: { id: `cap-${grain}`, auth: { current: { attributes: grain === "task" ? { oe_grain: "task" } : {} } } },
  } as BindableContext;
};

async function mountedGatedNames(grain: "standing" | "task" | "native"): Promise<Set<string>> {
  const mounted = new Set<string>();
  for (const [name, mod] of Object.entries(gatedModules)) {
    if ((await resolveWindowGated(mod, grainCtxOf(grain))) !== null) mounted.add(name);
  }
  const kit = (await resolveWindowGated(sandboxKit, grainCtxOf(grain))) as Record<string, unknown> | null;
  for (const name of Object.keys(kit ?? {})) mounted.add(name);
  return mounted;
}

{
  const standing = await mountedGatedNames("standing");
  const task = await mountedGatedNames("task");
  const native = await mountedGatedNames("native");
  for (const name of FULL_CAPABILITY_TOOLS) {
    const entry = TOOL_CONSEQUENCE[name];
    ok(entry !== undefined, `[P0-a] "${name}" keeps its consequence-registry row (tier is orthogonal to the gate)`);
    ok(isMountedTier(entry.tier), `[P0-a] "${name}" keeps its mounted tier (tier=${entry?.tier}) — availability now comes from the GRAIN, not this table`);
  }
  for (const name of withheldFromGrain("standing")) {
    ok(!standing.has(name), `[P0-a] "${name}" is STRUCTURALLY ABSENT on the standing window seat (resolved null — no tool to see, reach for, or retry into)`);
  }
  eq([...standing].sort(), [], "[P0-a] delegation disarmed, the standing seat's gated-kit residue is EMPTY — no wide hands, and no delegation verb either");
  eq(
    [...task].sort(),
    [...SANDBOX_SIX, "checkout_repo", "create_skill", "delete_skill", "open_pull_request", "post_file"].sort(),
    "[P0-a] the task worker mounts the FULL wide-hands kit",
  );
  eq(
    [...native].sort(),
    [...SANDBOX_SIX, "checkout_repo", "create_skill", "delete_skill", "open_pull_request", "post_file"].sort(),
    "[P0-a] the native mention keeps the FULL wide-hands kit (over-narrowing a native seat is the F8 failure mode)",
  );
  eq(TOOL_CONSEQUENCE.checkout_repo?.tier, "open", "[P0-a] checkout_repo stays `open` in the registry — the narrowing is the GRAIN gate, not a tier change");
}

console.log("P0-a(1b) — spawn_thread_session token-aware mount (DM dead-affordance fix):");
{
  overrideSettingsForTest({ delegation: { oneshotAgent: true } });
  try {
    const spawnMod = gatedModules.spawn_thread_session;
    const standingAttrs = { oe_grain: "standing" };
    const dmNativeStanding = {
      channel: { kind: "slack", continuationToken: "cse_dm_native_seat" },
      session: { id: "cap-dm-standing", auth: { current: { attributes: standingAttrs } } },
    } as BindableContext;
    const windowStanding = {
      channel: { kind: "unified", continuationToken: `unified:${formatWindowToken({ domain: "payments", windowId: "payments", generation: 7 })}` },
      session: { id: "cap-window-standing", auth: { current: { attributes: standingAttrs } } },
    } as BindableContext;
    const blankStanding = {
      channel: { kind: "unified" },
      session: { id: "cap-blank-standing", auth: { current: { attributes: standingAttrs } } },
    } as BindableContext;
    const perContainerStanding = {
      channel: { kind: "slack", continuationToken: "slack/T1/C_PAY:oe-sup:g7" },
      session: { id: "cap-percontainer-standing", auth: { current: { attributes: {} } } },
    } as BindableContext;

    eq(windowGrainOf(dmNativeStanding), "standing", "[P0-a(1b)] the DM native-token seat is grain STANDING (the oe_grain stamp)");
    eq(windowGrainOf(windowStanding), "standing", "[P0-a(1b)] the window-token seat is grain STANDING");
    eq(await resolveWindowGated(spawnMod, dmNativeStanding), null, "[P0-a(1b)] spawn_thread_session is ABSENT on a native-token (DM) standing seat — no window to mint into, so no mounted-then-refusing dead affordance");
    ok((await resolveWindowGated(spawnMod, windowStanding)) !== null, "[P0-a(1b)] spawn_thread_session IS mounted on a window-token standing seat (minting a seat is the standing seat's job — the fix must not over-remove)");
    ok((await resolveWindowGated(spawnMod, blankStanding)) !== null, "[P0-a(1b)] spawn_thread_session fails OPEN on a blank-token standing seat (a degraded window-seat token is never wrongly stripped; the execute guard is the wall)");
    eq(await resolveWindowGated(spawnMod, perContainerStanding), null, "[P0-a(1b)] spawn_thread_session is ABSENT on a per-container standing seat (its token is not a window token, so it too can't mint a child)");

    const dmWindowStanding = {
      channel: { kind: "unified", continuationToken: `unified:${formatWindowToken(dmWindowKey("slack/T1/D999", 3))}` },
      session: { id: "cap-dm-window-standing", auth: { current: { attributes: standingAttrs } } },
    } as BindableContext;
    eq(windowGrainOf(dmWindowStanding), "standing", "[P0-a(1b)] a DM WINDOW seat is grain STANDING, exactly like the native-token DM seat it replaces");
    ok((await resolveWindowGated(spawnMod, dmWindowStanding)) !== null, "[P0-a(1b)/OPE-351] spawn_thread_session IS mounted on a DM WINDOW seat — the re-seat gives it a real window, and a thread seat in a DM is an ordinary conversational presence");

    overrideSettingsForTest({ delegation: { oneshotAgent: false } });
    eq(await resolveWindowGated(spawnMod, windowStanding), null, "[P0-a(1b)] delegation DISARMED ⇒ spawn_thread_session is absent even on a real window seat (the flag half fails CLOSED)");
  } finally {
    overrideSettingsForTest({ delegation: { oneshotAgent: false } });
  }
}

withWindowEnv(() => {
  const SLACK = "slack/T1/C_PAY";
  const GH = "github/acme/payments-api";
  const orgGate = defineDomain({ name: "org", match: "org" });
  const multiSourceWindow = defineDomain({
    name: "payments",
    channels: [SLACK, GH],
    ambientSupervisor: true,
    mode: "unified",
  });
  const grain = supervisorGrainFor(SLACK, [multiSourceWindow, orgGate]);
  ok(grain.unified === true && grain.singleWindow === true, "[P0-a] a 2-source mode:unified domain resolves a single-window supervisor grain");
  const keys = Object.keys(grain).sort();
  eq(keys, ["domainName", "registryKey", "singleWindow", "unified"], "[P0-a] the supervisor grain carries no tool field — narrowing lives at the windowGrainOf/session.started seam, not in dispatch data");
});

console.log("P0-d — vouch is runtime today; config-validation twin staged:");

_resetSurfacesForTest();
registerSurfaces([defineSurface({ key: "slack/T1/C_VOUCHED", trust: "internal" })]);
{
  const vouched = isVouchedInternal("slack/T1", "slack/T1/C_VOUCHED");
  const unvouched = isVouchedInternal("slack/T1", "slack/T1/C_OPEN");
  ok(vouched === true, "[P0-d] a registered surface is vouched-internal (privacyOk source)");
  ok(unvouched === false, "[P0-d] an unregistered surface is NOT vouched — fail-closed");

  const admitted = singleWindowMentionPolicy(true, true, vouched);
  eq(admitted, { suppressNative: true, addressing: "direct-mention" }, "[P0-d] vouched single-window mention ⇒ ADMITTED to the window (native suppressed, addressed)");
  const refused = singleWindowMentionPolicy(true, true, unvouched);
  eq(refused, { suppressNative: false, addressing: undefined }, "[P0-d] UN-vouched single-window mention ⇒ NOT admitted (native keeps the mention) — the runtime vouch");
}
_resetSurfacesForTest();

{
  const orgGate = defineDomain({ name: "org", match: "org" });
  const multiSourceUnvouched = defineDomain({
    name: "payments",
    channels: ["slack/T1/C_VOUCHED", "github/acme/secret"],
    ambientSupervisor: true,
    mode: "unified",
  });
  const domainMod: Record<string, unknown> = await import("../agent/memory/domain.js");
  const assertUnifiedDomainTrust = domainMod.assertUnifiedDomainTrust as (d: readonly unknown[]) => void;
  noThrow(
    () => assertUnifiedDomainTrust([multiSourceUnvouched, orgGate] as never),
    "[P0-d] TODAY: assertUnifiedDomainTrust does NOT throw on an unvouched source in a multi-source window (config-load vouch gap)",
  );

  const assertWindowSourcesVouched = domainMod.assertWindowSourcesVouched as (d: readonly unknown[], vouched: readonly string[]) => void;
  ok(typeof assertWindowSourcesVouched === "function", "[P0-d] assertWindowSourcesVouched is now exported (config-load vouch validation landed)");
  assert.throws(
    () => assertWindowSourcesVouched([multiSourceUnvouched, orgGate] as never, ["slack/T1/C_VOUCHED"]),
    /github\/acme\/secret/,
    "[P0-d] multi-source window with an unvouched source throws at config load",
  );
  n++;
  const soloUnvouched = defineDomain({
    name: "solo",
    channels: ["github/acme/secret"],
    ambientSupervisor: true,
    mode: "unified",
  });
  assert.doesNotThrow(() => assertWindowSourcesVouched([soloUnvouched, orgGate] as never, []), "[P0-d] a SOLO window over the same unvouched source does NOT throw (vouch gates multi-source only)");
  n++;
}

console.log("P1-c — native-DM full-capability golden (over-narrowing guard):");

eq(singleWindowMentionPolicy(false, true, true), { suppressNative: false, addressing: undefined }, "[P1-c] non-window session: native handler OWNS the mention (full-capability path)");
eq(singleWindowMentionPolicy(false, false, true), { suppressNative: false, addressing: undefined }, "[P1-c] non-window ambient: unchanged (native split)");

const NATIVE_DM_CAPABILITY_GOLDEN: Readonly<Record<string, ConsequenceTier>> = {
  checkout_repo: "open",
  bash: "open",
  web_fetch: "open",
  write_file: "open",
  post_file: "open",
  open_pull_request: "gate:member",
  create_skill: "gate:member",
  create_routine: "gate:member",
};
const nativeActual: Record<string, ConsequenceTier> = {};
for (const name of Object.keys(NATIVE_DM_CAPABILITY_GOLDEN)) {
  const entry = TOOL_CONSEQUENCE[name];
  ok(entry !== undefined, `[P1-c] native session mounts "${name}"`);
  nativeActual[name] = entry.tier;
}
eq(nativeActual, NATIVE_DM_CAPABILITY_GOLDEN, "[P1-c] native-DM full-capability golden — the registry tiers the gate must never re-tier");

console.log("P0-e — assertWindowSourcesVouched direct unit tests:");
{
  const orgGate = defineDomain({ name: "org", match: "org" });
  const win = (channels: string[], name = "win") =>
    defineDomain({ name, channels, ambientSupervisor: true, mode: "unified" });

  noThrow(
    () => assertWindowSourcesVouched([win(["github/acme/one", "notion/ws/pg"]), orgGate], ["github/acme", "notion/ws"]),
    "[P0-e] workspace-grain vouch (github/acme, notion/ws) satisfies surfaces under it",
  );
  noThrow(
    () => assertWindowSourcesVouched([win(["github/acme/one", "linear/org/team"]), orgGate], ["github/acme/one", "linear/org/team"]),
    "[P0-e] surface-grain vouch satisfies the exact source",
  );
  {
    process.env.OE_TRUST = "internal";
    noThrow(
      () => assertWindowSourcesVouched([win(["github/acme/one", "notion/ws/pg"]), orgGate], []),
      "[P0-e] OE_TRUST=internal blanket satisfies all sources with an EMPTY vouch set",
    );
    delete process.env.OE_TRUST;
  }
  noThrow(
    () => assertWindowSourcesVouched([win(["slack/T1/C_X", "github/acme/one"]), orgGate], ["github/acme/one"]),
    "[P0-e] a Slack source is EXEMPT from the register check (internal-by-binding) — only github must be vouched",
  );
  assert.throws(
    () => assertWindowSourcesVouched([win(["slack/T1/C_X", "teams/g123/topic"]), orgGate], []),
    /teams\/g123\/topic/,
    "[P0-e] a NON-binding-trusted platform (teams) still throws when unvouched",
  );
  n++;
  assert.throws(
    () => assertWindowSourcesVouched([win(["github/a/x", "notion/b/y"]), orgGate], []),
    /github\/a\/x[\s\S]*notion\/b\/y/,
    "[P0-e] all unvouched sources are listed in a single error",
  );
  n++;
  assert.throws(
    () => assertWindowSourcesVouched([win(["github/a/x", "notion/b/y"]), orgGate], []),
    /notion\/b\/y[\s\S]*Notion TRUST ROOT does not satisfy this gate/,
    "[P0-e] an unvouched NOTION source explains that a trust root cannot satisfy a config-load gate (OPE-540)",
  );
  n++;
  {
    let message = "";
    try {
      assertWindowSourcesVouched([win(["github/a/x", "github/b/y"]), orgGate], []);
    } catch (e) {
      message = (e as Error).message;
    }
    ok(message.includes("github/a/x") && !message.includes("TRUST ROOT"), "[P0-e] a non-notion offender carries NO trust-root clause (the note is notion-only)");
  }
  noThrow(() => assertWindowSourcesVouched([win(["github/a/x"], "solo"), orgGate], []), "[P0-e] solo (1-channel) window over an unvouched source does NOT throw");
  noThrow(
    () => assertWindowSourcesVouched([defineDomain({ name: "plain", channels: ["github/a/x", "github/b/y"] }), orgGate], []),
    "[P0-e] a non-window (no crossSurfaceWindow) multi-channel domain is never vouch-checked",
  );

  const groupedWin = (windows: readonly { name: string; channels: readonly string[] }[], channels: string[], mode?: "solo" | "unified") =>
    defineDomain({ name: "grouped", channels, ambientSupervisor: true, ...(mode ? { mode } : {}), windows });

  assert.throws(
    () => assertWindowSourcesVouched([groupedWin([{ name: "pair", channels: ["github/a/x", "notion/b/y"] }], ["github/a/x", "notion/b/y", "github/c/z"]), orgGate], []),
    /window "pair" of domain "grouped"[\s\S]*github\/a\/x[\s\S]*notion\/b\/y/,
    "[P0-e/1167] a named GROUP merging two unvouched sources throws even though the domain's mode is the solo residue",
  );
  n++;
  {
    let message = "";
    try {
      assertWindowSourcesVouched([groupedWin([{ name: "pair", channels: ["github/a/x", "notion/b/y"] }], ["github/a/x", "notion/b/y", "github/c/z"]), orgGate], []);
    } catch (e) {
      message = (e as Error).message;
    }
    ok(!message.includes("github/c/z"), "[P0-e/1167] a solo-residue channel in the same domain is NOT named — one-member windows stay exempt");
  }
  noThrow(
    () =>
      assertWindowSourcesVouched([groupedWin([{ name: "pair", channels: ["github/a/x", "notion/b/y"] }], ["github/a/x", "notion/b/y", "github/c/z"]), orgGate], [
        "github/a/x",
        "notion/b/y",
      ]),
    "[P0-e/1167] vouching the GROUP's members satisfies the gate; the unvouched solo member is irrelevant",
  );
  noThrow(
    () => assertWindowSourcesVouched([groupedWin([{ name: "lone", channels: ["github/a/x"] }], ["github/a/x", "github/c/z"]), orgGate], []),
    "[P0-e/1167] a ONE-member group is exempt (a window with one source cannot bleed cross-context)",
  );
  noThrow(
    () => assertWindowSourcesVouched([groupedWin([{ name: "mix", channels: ["slack/T1/C_X", "github/a/x"] }], ["slack/T1/C_X", "github/a/x"]), orgGate], ["github/a/x"]),
    "[P0-e/1167] the binding-trusted-platform exemption applies inside a group too",
  );
  {
    const ch = "github/a/x";
    const expected =
      `  domain "win" includes UN-vouched source "${ch}" in a multi-source (2-channel) cross-surface window` +
      ` — vouch it in agent/identity/surfaces.ts (add "${ch}" or its workspace "github/a"),` +
      ` or set OE_TRUST=internal for an internal-only deploy`;
    let message = "";
    try {
      assertWindowSourcesVouched([win([ch, "notion/b/y"]), orgGate], []);
    } catch (e) {
      message = (e as Error).message;
    }
    ok(message.split("\n").includes(expected), "[P0-e/1167] a mode:unified domain with no groups emits the pre-OPE-1167 refusal line VERBATIM (byte-identical)");
  }
  noThrow(
    () =>
      assertWindowSourcesVouched(
        [defineDomain({ name: "carved", channels: ["github/a/x", "notion/b/y"], ambientSupervisor: true, mode: "unified", windows: [{ name: "carve", channels: ["github/a/x"] }] }), orgGate],
        [],
      ),
    "[P0-e/1167] carving a member into its own group shrinks the residue window to one source, which is exempt",
  );
}

console.log("P0-f — per-channel STANDING seat is NARROWED (Stage C flip):");
{
  const STANDING_KEPT = [
    "reply", "no_reply", "update_status", "react",
    "purge_memory",
    "create_routine", "subscribe_pr", "cancel_routine",
    "describe_image",
    "read_channel", "check_pr_status",
    "list_repos", "list_routines", "list_skills", "session_cost", "spend_report", "usage_report",
  ] as const;
  const STANDING_WITHHELD = [
    "checkout_repo", "bash", "glob", "grep", "read_file", "write_file",
    "web_fetch", "open_pull_request", "post_file",
    "create_skill", "delete_skill",
  ] as const;
  for (const name of [...STANDING_KEPT, ...STANDING_WITHHELD]) {
    const entry = TOOL_CONSEQUENCE[name];
    ok(entry !== undefined, `[P0-f] "${name}" keeps its consequence-registry row`);
    ok(isMountedTier(entry.tier), `[P0-f] "${name}" keeps its mounted tier (tier=${entry?.tier}) — availability is the grain's job, not the registry's`);
  }
  for (const name of STANDING_KEPT) {
    ok(WINDOW_GATED_TOOLS[name] === undefined, `[P0-f] kept tool "${name}" is NOT grain-gated (mounts on every seat)`);
  }
  for (const name of STANDING_WITHHELD) {
    eq(WINDOW_GATED_TOOLS[name], ["task", "native"], `[P0-f] withheld tool "${name}" is grain-gated to task+native (absent on standing)`);
  }
  eq([...withheldFromGrain("standing")].sort(), [...STANDING_WITHHELD, "complete_thread"].sort(), "[P0-f] a standing seat withholds EXACTLY the 11 wide-hands tools + complete_thread (thread-lifecycle, thread-only) — `return_result` is gone with the roll-own regime, OPE-1145 item 2");

  ok(TOOL_CONSEQUENCE.spawn_thread_session?.tier === "open", "[P0-f] spawn_thread_session stays `open` — minting a seat is the standing seat's job");
  eq(WINDOW_GATED_TOOLS.spawn_thread_session, ["standing"], "[P0-f] spawn_thread_session is grain-gated STANDING-only (window-only mint; no recursive thread trees)");
  ok(TOOL_CONSEQUENCE.complete_thread?.tier === "open", "[P0-f] complete_thread stays `open`");
  eq(WINDOW_GATED_TOOLS.complete_thread, ["thread"], "[P0-f] complete_thread is grain-gated THREAD-only");
  eq(WINDOW_GATED_TOOLS.agent, ["standing", "thread"], "[P0-f] agent is grain-gated to the conversational-root seats (standing+thread) — the ONE name that cannot use mount-absence, because eve's harness injects its own built-in recursive subagent under `agent` unless a static authored tool claims the name; the gate runs at execute time via grainBackstopAtExecute instead");
  ok(TOOL_CONSEQUENCE.spawn === undefined && TOOL_CONSEQUENCE.dispatch === undefined && TOOL_CONSEQUENCE.delegate === undefined, "[P0-f] the delegation primitives are named exactly — no bare spawn/dispatch/delegate alias");

  const perContainerCtx = {
    channel: { kind: "slack", continuationToken: "slack/T1/C_STANDING:oe-sup:g3" },
    session: { id: "cap-per-container", auth: { current: { attributes: {} } } },
  } as BindableContext;
  eq(await resolveWindowGated(gatedModules.checkout_repo, perContainerCtx), null, "[P0-f] checkout_repo resolves NULL on a per-container standing seat (not on the unified channel — the grain predicate reaches it anyway)");
  eq(await resolveWindowGated(sandboxKit, perContainerCtx), null, "[P0-f] the sandbox six resolve NULL on a per-container standing seat");
  eq(await resolveWindowGated(gatedModules.spawn_thread_session, perContainerCtx), null, "[P0-f] spawn_thread_session is ABSENT on a per-container standing seat, delegation disarmed (the flag half; P0-a(1b) proves the token half with the flag armed)");

  const standingGrain = supervisorGrainFor("slack/T1/C_STANDING", [defineDomain({ name: "plain", channels: ["slack/T1/C_STANDING"], ambientSupervisor: true })]);
  ok(standingGrain.unified === false, "[P0-f] a plain ambient channel resolves a per-container (non-unified) standing grain");
  eq(Object.keys(standingGrain).sort(), ["registryKey", "unified"], "[P0-f] the standing-seat grain carries no tool field — narrowing lives at windowGrainOf/session.started");
}

console.log("P0-g — grain classification per seat type (Stage B §S3):");
{
  const ctxFor = (token: string | undefined, grain?: string): BindableContext => ({
    channel: token === undefined ? { kind: "unified" } : { kind: "unified", continuationToken: token },
    session: { auth: { current: { attributes: grain ? { oe_grain: grain } : {} } } },
  });
  const uni = formatWindowToken({ domain: "payments", windowId: "payments", generation: 4 });
  const solo = formatWindowToken({ domain: "payments", windowId: "slack/T1/C_PAY", generation: 4 });
  const task = formatWindowToken({ domain: "payments", windowId: taskWindowId("slack/C1", "1720000000.5"), generation: 4 });
  eq(windowGrainOf(ctxFor(`unified:${uni}`, "standing")), "standing", "[P0-g] multi-source unified window (stamp standing) ⇒ standing ⇒ NARROW");
  eq(windowGrainOf(ctxFor(`unified:${solo}`, "standing")), "standing", "[P0-g] per-domain solo window ⇒ standing ⇒ NARROW");
  eq(windowGrainOf(ctxFor("slack/T1/C_PAY:oe-sup:g4")), "standing", "[P0-g] per-container ambient (T1) seat ⇒ standing ⇒ NARROW (backstop, no stamp)");
  eq(windowGrainOf(ctxFor("slack/T1/D_DM:oe-sup:g4")), "standing", "[P0-g] root DM standing seat ⇒ standing ⇒ NARROW");
  eq(windowGrainOf(ctxFor(`unified:${task}`, "task")), "task", "[P0-g] task/thread session (§S1) ⇒ task ⇒ FULL");
  eq(windowGrainOf(ctxFor("cse_native123")), "native", "[P0-g] native mention `cse_…` session ⇒ native ⇒ FULL");
  eq(windowGrainOf(ctxFor("slack/T1/C_PAY:oe-sup:g4", "task")), "standing", "[P0-g] a `task` stamp on a standing token ⇒ standing (fail-closed; grain is unforgeable)");
}

console.log(`\nwindow-capability: ${n} assertions passed.`);
