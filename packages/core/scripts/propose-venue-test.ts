import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "oe-propose-venue-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
process.env.OE_EGRESS_SPOOF = "1";
delete process.env.OE_PLATFORM;
delete process.env.OE_MEMORY_FLOAT;

let n = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  n++;
}
async function refuses(fn: () => unknown, needle: RegExp, label: string): Promise<void> {
  let msg: string | null = null;
  try {
    await fn();
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  ok(msg !== null && needle.test(msg), `${label} (got: ${msg ?? "no throw"})`);
}

const { registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
registerSlackFixtureMapper();

const { registerIdentityMapper } = await import("../agent/identity/binding.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
await import("../agent/approvals/flow.js");
await import("../agent/approvals/memory-forget.js");
await import("../agent/approvals/access-request.js");
await import("../agent/approvals/routine-cancel.js");
await import("../agent/approvals/routine-lifecycle.js");
await import("../agent/approvals/routine-policy.js");
await import("../agent/approvals/memory-remember.js");
await import("../agent/approvals/skill-create.js");
await import("../agent/approvals/skill-delete.js");
await import("../agent/approvals/pr-open.js");

registerIdentityMapper("teams", (ctx) => {
  const a = ((ctx as { session?: { auth?: { current?: { attributes?: Record<string, string> } } } }).session?.auth?.current?.attributes ?? {}) as Record<string, string>;
  return {
    workspace: a["workspace_id"],
    surface: a["conversation_id"],
    mode: "channel" as const,
    visibility: "private" as const,
    trust: "internal" as const,
    principalId: a["user_id"],
    ...(a["conversation_id"] ? { target: { channelId: a["conversation_id"] } } : {}),
  };
});

const DOMAINS = [
  defineDomain({ name: "eng", channels: ["teams/W1/CONV1", "slack/T1/C_OPS"], memory: "eng-brain" }),
  defineDomain({ name: "lonely", channels: ["teams/W1/CONV_LONE"], memory: "eng-brain" }),
  defineDomain({ name: "slackside", channels: ["slack/T1/C1"], memory: "eng-brain" }),
];

const CONNECTIONS = [{ id: "notion-rest", credentialType: "bearer" as const, secretRef: "NOTION_API_KEY", allowedWebsites: ["api.notion.com"], methods: ["GET" as const] }];
const BUNDLES = [
  { name: "notion", connections: CONNECTIONS },
  { name: "linear-basket", connectors: ["linear"] },
  { name: "coding", repos: ["acme/web"] },
];
const BINDINGS = [
  { bundle: "linear-basket", scope: { level: "surface" as const, surface: "slack/T1/C9" } },
  { bundle: "coding", scope: { level: "org" as const } },
];
process.env.GITHUB_TOKEN = "test-pat";

registerConfig({
  loadBundles: () => BUNDLES,
  loadBindings: () => BINDINGS,
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => DOMAINS,
  loadSilos: () => [{ name: "eng-brain", provider: "sqlite" }],
  domainsForSurface: () => [],
  loadAccessRequests: () => ({
    adminChannel: "C_ADMIN",
    configRepo: "acme/agent-config",
    baseBundles: () => BUNDLES,
    baseBindings: () => BINDINGS,
    dryRun: true,
  }),
});

const forgetTool = (await import("../agent/tools/forget.js")).default;
const requestAccessTool = (await import("../agent/tools/request_access.js")).default;
const revokeTool = (await import("../agent/tools/revoke_connector.js")).default;
const clearTool = (await import("../agent/tools/clear_connector_override.js")).default;
const setSpendTool = (await import("../agent/tools/set_spend_limit.js")).default;
const clearSpendTool = (await import("../agent/tools/clear_spend_limit.js")).default;

const cancelRoutineTool = (await import("../agent/tools/cancel_routine.js")).default;
const editRoutineTool = (await import("../agent/tools/edit_routine.js")).default;
const enableRoutineTool = (await import("../agent/tools/enable_routine.js")).default;
const addRoutineRuleTool = (await import("../agent/tools/add_routine_rule.js")).default;
const removeRoutineRuleTool = (await import("../agent/tools/remove_routine_rule.js")).default;
const rememberTool = (await import("../agent/tools/remember.js")).default;
const createSkillTool = (await import("../agent/tools/create_skill.js")).default;
const deleteSkillTool = (await import("../agent/tools/delete_skill.js")).default;
const openPullRequestTool = (await import("../agent/tools/open_pull_request.js")).default;

type Entry = { execute: (input: unknown, ctx: unknown) => Promise<Record<string, unknown>> };
async function armed(def: unknown, ctx: unknown, name: string): Promise<Entry> {
  const handler = (def as { events?: Record<string, (e: unknown, c: unknown) => unknown> }).events?.["session.started"];
  const entry = handler ? await handler({}, ctx) : def;
  ok(entry !== null && typeof (entry as Entry).execute === "function", `${name} is MOUNTED on this surface (a null resolver would make every assertion below vacuous)`);
  return entry as Entry;
}

const BULLET = "- 2026-07-01: Ada owns billing";
const MEMORY_MD = `# Memory\n\n## People / ownership\n${BULLET}\n`;
const STAGED_SHA = "1".repeat(40);
const sandbox = {
  readTextFile: async ({ path }: { path: string }) => (path.endsWith("/MEMORY.md") ? MEMORY_MD : null),
  run: async () => ({ exitCode: 0, stdout: `__OE_STAGED_SHA__ ${STAGED_SHA}`, stderr: "" }),
  setNetworkPolicy: async () => {},
};

const teamsCtx = (conversationId: string, continuationToken?: string) =>
  ({
    channel: { kind: "teams", ...(continuationToken ? { continuationToken } : {}) },
    session: { auth: { current: { attributes: { workspace_id: "W1", conversation_id: conversationId, user_id: "U_ASK" }, principalId: "U_ASK" } } },
    getSandbox: async () => sandbox,
  }) as never;

const slackCtx = (channelId: string, continuationToken?: string) =>
  ({
    channel: { kind: "slack", ...(continuationToken ? { continuationToken } : {}) },
    session: {
      auth: { current: { attributes: { team_id: "T1", channel_id: channelId, channel_type: "channel", trust_checked: "true", user_id: "U_ASK" }, principalId: "U_ASK" } },
    },
    getSandbox: async () => sandbox,
  }) as never;

async function rowOf(pendingId: string): Promise<Record<string, unknown>> {
  const row = await getOperationalStore().getPendingAction("default", pendingId);
  ok(row !== null, `a pending row exists for ${pendingId}`);
  return row as unknown as Record<string, unknown>;
}
async function pendingCount(): Promise<number> {
  return (await getOperationalStore().listPendingActions("default")).length;
}

const { addRoutine } = await import("../agent/routines/store.js");
const { putDomainSkill } = await import("../agent/skills/domain-skills.js");
type Routine = import("../agent/routines/routine.js").Routine;
function routineFixture(over: Partial<Routine> & Pick<Routine, "id" | "surfaceKey">): Routine {
  return {
    org: "default",
    target: { channelId: over.surfaceKey.split("/").pop()! },
    trigger: { kind: "interval", everyMinutes: 30 },
    prompt: "Post the morning digest.",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
    ...over,
  };
}
await addRoutine(undefined as never, routineFixture({
  id: "r-active-1",
  surfaceKey: "teams/W1/CONV1",
  policy: [{ id: "p-existing1", rule: "never post before 09:00 UTC", why: "a 03:12 run woke the channel", addedAt: "2026-07-01T00:00:00.000Z", addedBy: "U_ADMIN", source: "human" }],
}));
await addRoutine(undefined as never, routineFixture({
  id: "r-disabled-1",
  surfaceKey: "teams/W1/CONV1",
  status: "disabled",
  disabledReason: "auto-disabled after 3 consecutive failures",
  consecutiveFailures: 3,
}));
await addRoutine(undefined as never, routineFixture({ id: "r-lonely-1", surfaceKey: "teams/W1/CONV_LONE" }));
await addRoutine(undefined as never, routineFixture({ id: "r-slack-1", surfaceKey: "slack/T1/C1" }));
await putDomainSkill("default", "eng", "existing-skill", "Do the thing.", "U_ADMIN", "2026-07-01T00:00:00.000Z", { armedBy: "U_ADMIN" });

{
  const out = (await (await armed(forgetTool, teamsCtx("CONV1"), "forget")).execute({ match: "Ada owns billing" }, teamsCtx("CONV1"))) as {
    requested: boolean;
    pendingId: string;
    note: string;
  };
  ok(out.requested === true, "redirect: 🔴 `forget` WORKS from a card-less room — this is the leg OPE-295 item 3 declined to land, because before its prerequisites it would have been unreachable");
  const row = await rowOf(out.pendingId);
  ok(row["channelId"] === "C_OPS", "redirect: the card is posted into the domain's card-capable channel, not the asking room");
  ok(row["postedTo"] === "slack/T1/C_OPS", "redirect: …and `postedTo` is the VENUE's key — the TTL sweep and the decision wake both go looking there, so a stale asking-room key would strand the row");
  ok(row["threadTs"] === null, "redirect: a cross-venue card posts TOP-LEVEL — a thread ts belongs to a different workspace's channel and anchors nothing there");
  ok(row["scopeKey"] === "teams/W1/CONV1", "redirect: the SCOPE stays the asking surface — the card moved, the subject of the decision did not");
  ok(out.note.includes("card posted in slack/T1/C_OPS"), "redirect: the tool result NAMES where the card went");
  ok(
    out.note.includes("tell the user where it is, by name"),
    "redirect: …and instructs the model to relay it — a user who sees no confirmation reads it as 'the agent ignored me', and the card is by construction invisible from here",
  );

  const ra = (await (await armed(requestAccessTool, teamsCtx("CONV1"), "request_access")).execute(
    { kind: "grant-connector", connector: "linear", reason: "triage needs Linear" },
    teamsCtx("CONV1"),
  )) as { requested: boolean; pendingId: string; note: string };
  ok(ra.requested === true, "redirect: 🔴 `request_access` works from a card-less room too");
  const raRow = await rowOf(ra.pendingId);
  ok(raRow["channelId"] === "C_OPS" && raRow["postedTo"] === "slack/T1/C_OPS", "redirect: …with the card in the venue");
  ok(ra.note.includes("card posted in slack/T1/C_OPS") && ra.note.includes("tap it to send the request"), "redirect: …and a relay instruction naming what the person there must DO (not merely that they must do something)");

  const frozen = JSON.parse(raRow["argsJson"] as string) as Record<string, unknown>;
  ok(
    frozen["channelId"] === "CONV1",
    "args-vs-card: 🔴 the frozen args keep the ASKING channel — the bot-PR cites it as 'where this was asked' and the outcome note goes back there, so conflating it with the venue would put the wrong room in a diff an admin reads",
  );
  ok(frozen["scopeKey"] === "teams/W1/CONV1", "args-vs-card: …and the scope being widened is still the asking surface's");

  const rv = (await revokeTool.execute({ connector: "notion", reason: "leaked token" } as never, teamsCtx("CONV1"))) as { pendingId: string; note: string };
  const rvRow = await rowOf(rv.pendingId);
  ok(rvRow["postedTo"] === "slack/T1/C_OPS", "redirect: break-glass `revoke_connector` routes too — an incident does not wait for the responder to move to a chat app they may not be in");
  ok(rv.note.includes("card posted in slack/T1/C_OPS") && rv.note.includes("approve it"), "redirect: …and says where and what next");
  ok(JSON.parse(rvRow["argsJson"] as string).scopeKey === "teams/W1/CONV1", "redirect: …while still revoking the ASKING surface's connector, not the venue's");

  const cl = (await (await armed(clearTool, teamsCtx("CONV1"), "clear_connector_override")).execute({ connector: "notion" }, teamsCtx("CONV1"))) as {
    pendingId: string;
    note: string;
  };
  ok((await rowOf(cl.pendingId))["postedTo"] === "slack/T1/C_OPS", "redirect: …and its clear moves with it — revoke-without-clear is a one-way door");
}

{
  const set = (await (await armed(setSpendTool, teamsCtx("CONV1"), "set_spend_limit")).execute(
    { monthlyUsd: 50, reason: "incident headroom" },
    teamsCtx("CONV1"),
  )) as { requested: boolean; pendingId: string; note: string };
  ok(set.requested === true, "spend-pair: 🔴 `set_spend_limit` WORKS from a card-less room — it was MOUNTED there all along and refused at execute(), which is the worse half of the inconsistency: the agent could see a tool it could not use and said so only after being asked");
  const setRow = await rowOf(set.pendingId);
  ok(setRow["channelId"] === "C_OPS" && setRow["postedTo"] === "slack/T1/C_OPS", "spend-pair: the card is in the domain's card-capable channel, and `postedTo` is the VENUE's key");
  ok(setRow["threadTs"] === null, "spend-pair: …top-level, like every other cross-venue card");
  ok(setRow["scopeKey"] === "teams/W1/CONV1", "spend-pair: …while the cap being proposed is still the ASKING surface's — the card moved, the subject of the decision did not");
  ok(set.note.includes("card posted in slack/T1/C_OPS") && set.note.includes("approve it"), "spend-pair: …and the tool result names the venue and what the person there must do");

  const clearSpend = (await (await armed(clearSpendTool, teamsCtx("CONV1"), "clear_spend_limit")).execute({}, teamsCtx("CONV1"))) as {
    pendingId: string;
    note: string;
  };
  const clearSpendRow = await rowOf(clearSpend.pendingId);
  ok(clearSpendRow["postedTo"] === "slack/T1/C_OPS", "spend-pair: …and its clear moves with it — a room that can RAISE a cap but never clear the override it set is a one-way door");

  const clearOverride = (await (await armed(clearTool, teamsCtx("CONV1"), "clear_connector_override")).execute({ connector: "linear" }, teamsCtx("CONV1"))) as {
    pendingId: string;
    note: string;
  };
  const overrideRow = await rowOf(clearOverride.pendingId);
  ok(
    clearSpendRow["channelId"] === overrideRow["channelId"] &&
      clearSpendRow["postedTo"] === overrideRow["postedTo"] &&
      clearSpendRow["threadTs"] === overrideRow["threadTs"],
    "spend-pair: 🔴 `clear_spend_limit` and `clear_connector_override` now route IDENTICALLY from one Teams room — same venue, same postedTo, same anchor. That divergence was the whole ticket",
  );
  ok(
    clearSpend.note.includes("card posted in slack/T1/C_OPS") === clearOverride.note.includes("card posted in slack/T1/C_OPS") &&
      clearSpend.note.includes("tell the user where it is, by name") === clearOverride.note.includes("tell the user where it is, by name"),
    "spend-pair: …and say the same thing about it — a user asking the same room to undo two overrides gets one story, not two",
  );
}

{
  const before = await pendingCount();

  await refuses(
    () => (armed(forgetTool, teamsCtx("CONV_LONE"), "forget") as Promise<Entry>).then((e) => e.execute({ match: "Ada owns billing" }, teamsCtx("CONV_LONE"))),
    /I can't forget that from here.*domain "lonely" has no Slack or Discord channel.*domains\.ts/s,
    "refuse: no card-capable channel in the domain ⇒ refusal naming the DOMAIN and the FILE — an action, never a description of the blockage",
  );
  await refuses(
    () => revokeTool.execute({ connector: "notion", reason: "x" } as never, teamsCtx("CONV_LONE")),
    /I can't revoke that connector from here/,
    "refuse: …and each tool names ITS OWN verb in the refusal",
  );

  await refuses(
    () => (armed(requestAccessTool, teamsCtx("CONV_ORPHAN"), "request_access") as Promise<Entry>).then((e) => e.execute({ kind: "grant-connector", connector: "linear" }, teamsCtx("CONV_ORPHAN"))),
    /I can't request that access from here.*isn't in an explicit domain.*domains\.ts/s,
    "refuse: a channel in NO domain refuses with the other reason — the config change is a different one, and naming the wrong one is how a refusal becomes useless",
  );

  await refuses(
    () => (armed(setSpendTool, teamsCtx("CONV_LONE"), "set_spend_limit") as Promise<Entry>).then((e) => e.execute({ monthlyUsd: 5, reason: "x" }, teamsCtx("CONV_LONE"))),
    /I can't set that spend limit from here.*domain "lonely" has no Slack or Discord channel.*domains\.ts/s,
    "refuse: `set_spend_limit` refuses with the venue's copy and its own verb",
  );
  await refuses(
    () => (armed(clearSpendTool, teamsCtx("CONV_ORPHAN"), "clear_spend_limit") as Promise<Entry>).then((e) => e.execute({}, teamsCtx("CONV_ORPHAN"))),
    /I can't clear that spend override from here.*isn't in an explicit domain.*domains\.ts/s,
    "refuse: …and `clear_spend_limit` on a channel in NO domain gets the other reason, not a generic one",
  );

  ok(await pendingCount().then((after) => after === before), "refuse: 🔴 NOTHING is minted on any refusal — a card nobody can see is worse than a clear no");
}

{
  const out = (await (await armed(forgetTool, slackCtx("C1"), "forget")).execute({ match: "Ada owns billing" }, slackCtx("C1"))) as {
    pendingId: string;
    note: string;
  };
  const row = await rowOf(out.pendingId);
  ok(row["channelId"] === "C1" && row["postedTo"] === "slack/T1/C1", "unchanged: a card-capable own room hosts its own card — the overwhelmingly common path must not move");
  ok(!out.note.includes("card posted in"), "unchanged: …the note says plain 'card posted', with no venue named");
  ok(
    !out.note.includes("This surface can't host an approval card"),
    "unchanged: 🔴 …and NO redirect sentence is appended — the relay instruction exists for a card the user cannot see, and telling them to go elsewhere for one that is right there is worse than saying nothing",
  );
  ok(/^card posted — forget [0-9a-f]{12}… \(pending [0-9a-f-]{36}\)\.$/.test(out.note), "unchanged: …byte-for-byte the pre-OPE-303 note shape, digest-only (the fact never enters the durable transcript)");

  const spend = (await (await armed(setSpendTool, slackCtx("C1"), "set_spend_limit")).execute({ monthlyUsd: 12, reason: "headroom" }, slackCtx("C1"))) as {
    pendingId: string;
    note: string;
  };
  const spendRow = await rowOf(spend.pendingId);
  ok(spendRow["channelId"] === "C1" && spendRow["postedTo"] === "slack/T1/C1", "unchanged: `set_spend_limit` in a card-capable own room hosts its own card, with the asking room's key frozen");
  ok(
    /^card posted — surface limit \$12\.00\/month \(current: uncapped\) on "slack\/T1\/C1" \(pending [0-9a-f-]{36}\)\.$/.test(spend.note),
    "unchanged: 🔴 …and the note is byte-for-byte the pre-OPE-312 sentence — no venue named, NO redirect instruction appended, because telling someone to go elsewhere for a card that is right there is worse than saying nothing",
  );
}

{
  const cancel = (await (await armed(cancelRoutineTool, teamsCtx("CONV1"), "cancel_routine")).execute({ id: "r-active-1" }, teamsCtx("CONV1"))) as {
    pending: boolean;
    pendingId: string;
    message: string;
  };
  ok(cancel.pending === true, "325-redirect: 🔴 `cancel_routine` WORKS from a card-less room — it used to refuse outright on `hasApprovalCardPath`");
  const cancelRow = await rowOf(cancel.pendingId);
  ok(cancelRow["channelId"] === "C_OPS" && cancelRow["postedTo"] === "slack/T1/C_OPS" && cancelRow["threadTs"] === null, "325-redirect: cancel_routine's card is in the venue, top-level");
  ok(cancel.message.includes("card posted in slack/T1/C_OPS") && cancel.message.includes("tell the user where it is, by name") && cancel.message.includes("confirm the cancellation"), "325-redirect: …names the venue and the reader's own verb");

  const edit = (await (await armed(editRoutineTool, teamsCtx("CONV1"), "edit_routine")).execute({ id: "r-active-1", prompt: "New instruction." }, teamsCtx("CONV1"))) as {
    pending: boolean;
    pendingId: string;
    message: string;
  };
  const editRow = await rowOf(edit.pendingId);
  ok(editRow["postedTo"] === "slack/T1/C_OPS", "325-redirect: edit_routine routes too");
  ok(edit.message.includes("card posted in slack/T1/C_OPS") && edit.message.includes("confirm the rewrite"), "325-redirect: …with its own verb");

  const enable = (await (await armed(enableRoutineTool, teamsCtx("CONV1"), "enable_routine")).execute({ id: "r-disabled-1" }, teamsCtx("CONV1"))) as {
    pending: boolean;
    pendingId: string;
    message: string;
  };
  const enableRow = await rowOf(enable.pendingId);
  ok(enableRow["postedTo"] === "slack/T1/C_OPS", "325-redirect: enable_routine routes too");
  ok(enable.message.includes("card posted in slack/T1/C_OPS") && enable.message.includes("confirm the re-arm"), "325-redirect: …with its own verb");

  const addRule = (await (await armed(addRoutineRuleTool, teamsCtx("CONV1"), "add_routine_rule")).execute(
    { routineId: "r-active-1", rule: "ignore drafts", why: "flaky pipeline", source: "human" },
    teamsCtx("CONV1"),
  )) as { pending: boolean; pendingId: string; message: string };
  const addRuleRow = await rowOf(addRule.pendingId);
  ok(addRuleRow["postedTo"] === "slack/T1/C_OPS", "325-redirect: add_routine_rule routes too");
  ok(addRule.message.includes("card posted in slack/T1/C_OPS") && addRule.message.includes("confirm the rule"), "325-redirect: …with its own verb");

  const removeRule = (await (await armed(removeRoutineRuleTool, teamsCtx("CONV1"), "remove_routine_rule")).execute(
    { routineId: "r-active-1", ruleId: "p-existing1" },
    teamsCtx("CONV1"),
  )) as { pending: boolean; pendingId: string; message: string };
  const removeRuleRow = await rowOf(removeRule.pendingId);
  ok(removeRuleRow["postedTo"] === "slack/T1/C_OPS", "325-redirect: remove_routine_rule routes too — the sibling that TAKES a guardrail away, same venue as the one that adds it");
  ok(removeRule.message.includes("card posted in slack/T1/C_OPS") && removeRule.message.includes("confirm the removal"), "325-redirect: …with its own verb");

  const remembered = (await (await armed(rememberTool, teamsCtx("CONV1"), "remember")).execute({ category: "standing", fact: "Never post before 09:00 UTC." }, teamsCtx("CONV1"))) as {
    pending: boolean;
    pendingId: string;
    note: string;
  };
  ok(remembered.pending === true, "325-redirect: 🔴 `remember`'s gated `standing` category WORKS from a card-less room too");
  const rememberedRow = await rowOf(remembered.pendingId);
  ok(rememberedRow["postedTo"] === "slack/T1/C_OPS", "325-redirect: …its card is in the venue");
  ok(remembered.note.includes("card posted in slack/T1/C_OPS") && remembered.note.includes("confirm it"), "325-redirect: …and the note names the venue and the verb");
  ok(JSON.parse(rememberedRow["argsJson"] as string).float === undefined, "325-redirect: …and with the float posture off, no float target is frozen at all (float, when armed, would stay the ORIGIN room — see remember.ts)");

  const skillCtx = teamsCtx("CONV1", "cse_test_native");
  const created = (await (await armed(createSkillTool, skillCtx, "create_skill")).execute({ name: "venue-skill", content: "Do the thing, carefully." }, skillCtx)) as {
    pending: boolean;
    pendingId: string;
    message: string;
  };
  ok(created.pending === true, "325-redirect: 🔴 `create_skill` WORKS from a card-less room — it used to refuse outright");
  const createdRow = await rowOf(created.pendingId);
  ok(createdRow["postedTo"] === "slack/T1/C_OPS" && createdRow["domain"] === "eng", "325-redirect: …its card is in the venue, and the DOMAIN frozen on the row is the skill's own (unlike the routine verbs, which freeze domain:null)");
  ok(created.message.includes("card posted in slack/T1/C_OPS") && created.message.includes("arm it"), "325-redirect: …and the message names the venue and the verb");

  const deleted = (await (await armed(deleteSkillTool, skillCtx, "delete_skill")).execute({ name: "existing-skill" }, skillCtx)) as {
    pending: boolean;
    pendingId: string;
    message: string;
  };
  const deletedRow = await rowOf(deleted.pendingId);
  ok(deletedRow["postedTo"] === "slack/T1/C_OPS", "325-redirect: delete_skill routes too — the sibling that TAKES a guardrail (a skill) away");
  ok(deleted.message.includes("card posted in slack/T1/C_OPS") && deleted.message.includes("confirm the removal"), "325-redirect: …with its own verb");

  const prCtx = teamsCtx("CONV1", "cse_test_native");
  const pr = (await (await armed(openPullRequestTool, prCtx, "open_pull_request")).execute({ repo: "acme/web", head: "fix/1", base: "main", title: "Fix the widget", body: "What changed." }, prCtx)) as {
    pending: boolean;
    pendingId: string;
    message: string;
  };
  ok(pr.pending === true, "325-redirect: 🔴 `open_pull_request` WORKS from a card-less room — it used to refuse outright, with nothing staged");
  const prRow = await rowOf(pr.pendingId);
  ok(prRow["channelId"] === "C_OPS" && prRow["postedTo"] === "slack/T1/C_OPS" && prRow["threadTs"] === null, "325-redirect: open_pull_request's card is in the venue, top-level");
  ok(pr.message.includes("card posted in slack/T1/C_OPS") && pr.message.includes("approve the publish"), "325-redirect: …names the venue and the verb");
  ok(JSON.parse(prRow["argsJson"] as string).headSha === STAGED_SHA, "325-redirect: …and the staged sha reached the frozen card args — the venue redirect did not skip the staging push");
}

{
  const before = await pendingCount();
  await refuses(
    () => cancelRoutineTool.execute({ id: "r-lonely-1" } as never, teamsCtx("CONV_LONE")),
    /I can't cancel that routine from here.*domain "lonely" has no Slack or Discord channel.*domains\.ts/s,
    "325-refuse: cancel_routine refuses with the venue's copy and its own verb — no card-capable channel in the domain",
  );
  const skillLoneCtx = teamsCtx("CONV_LONE", "cse_test_native");
  await refuses(
    () => (armed(createSkillTool, skillLoneCtx, "create_skill") as Promise<Entry>).then((e) => e.execute({ name: "x", content: "y" }, skillLoneCtx)),
    /I can't create that skill from here.*domain "lonely" has no Slack or Discord channel.*domains\.ts/s,
    "325-refuse: create_skill refuses with the same shape — a different verb, the same config fix",
  );
  ok(await pendingCount().then((after) => after === before), "325-refuse: 🔴 NOTHING is minted on either refusal");
}

{
  const cancel = (await (await armed(cancelRoutineTool, slackCtx("C1"), "cancel_routine")).execute({ id: "r-slack-1" }, slackCtx("C1"))) as {
    pendingId: string;
    message: string;
  };
  const cancelRow = await rowOf(cancel.pendingId);
  ok(cancelRow["channelId"] === "C1" && cancelRow["postedTo"] === "slack/T1/C1", "325-unchanged: cancel_routine in a card-capable own room hosts its own card");
  ok(!cancel.message.includes("card posted in") && !cancel.message.includes("This surface can't host an approval card"), "325-unchanged: …no venue named, no redirect sentence appended");

  const skillOwnCtx = slackCtx("C1", "cse_test_native");
  const created = (await (await armed(createSkillTool, skillOwnCtx, "create_skill")).execute({ name: "own-room-skill", content: "Do it here." }, skillOwnCtx)) as {
    pendingId: string;
    message: string;
    domain: string;
  };
  const createdRow = await rowOf(created.pendingId);
  ok(created.domain === "slackside" && createdRow["channelId"] === "C1" && createdRow["postedTo"] === "slack/T1/C1", "325-unchanged: create_skill in a card-capable own room hosts its own card, in its own domain");
  ok(!created.message.includes("card posted in") && !created.message.includes("This surface can't host an approval card"), "325-unchanged: …no venue named, no redirect sentence appended");
}

rmSync(tmp, { recursive: true, force: true });
console.log(
  `✓ propose-venue: ${n} assertions passed (card-less redirect for all six OPE-303/312 propose tools plus the nine OPE-325 tools, spend pair matches its sibling, args-vs-card split, fail-closed refusals, own-room unchanged)`,
);
