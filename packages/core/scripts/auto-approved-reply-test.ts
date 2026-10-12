import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { fileURLToPath } from "node:url";
import { removeTempDir } from "./_temp-dir.js";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-auto-approved-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });

const { registerConfig } = await import("../agent/access/config.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { resolveWindowGated } = await import("../agent/access/window-gated.js");
const { autoApprovedNote } = await import("../agent/approvals/flow.js");
const { PROPOSER_DECISION_NOTE } = await import("../agent/approvals/card-venue.js");
const { registerSlackFixtureMapper, registerSlackTestBridge } = await import("./_slack-test-stubs.js");
registerSlackFixtureMapper();
registerSlackTestBridge();

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
          name: "fastlane-lower",
          approve: (req: { readonly domain?: string; readonly action?: string }) =>
            req.domain === "fastlane" && (req.action === "skill.create" || req.action === "skill.delete") ? "allow" : undefined,
        },
      ],
    },
  ],
  loadBindings: () => [{ bundle: "org-policy", scope: { level: "org" } }],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [
    { name: "fastlane", reach: ["slack/T1/C_FAST"] },
    { name: "eng", reach: ["slack/T1/C_ENG"] },
  ],
  loadSilos: () => [],
  domainsForSurface: ({ surface }: { surface: string }) => (surface === "C_FAST" ? ["fastlane"] : surface === "C_ENG" ? ["eng"] : []),
});

const FULL_GRAIN_TEST_CTX = { channel: { kind: "slack" }, session: { auth: { current: { attributes: { oe_grain: "task" } } } } };
type ExecTool = { execute(input: unknown, ctx: unknown): Promise<Record<string, unknown>> };
const createSkillGated = (await import("../agent/tools/create_skill.js")).default;
const deleteSkillGated = (await import("../agent/tools/delete_skill.js")).default;
const createSkill = (await resolveWindowGated(createSkillGated, FULL_GRAIN_TEST_CTX as never)) as ExecTool;
const deleteSkill = (await resolveWindowGated(deleteSkillGated, FULL_GRAIN_TEST_CTX as never)) as ExecTool;

function ctxFor(channelId: string): unknown {
  return {
    channel: { kind: "slack" },
    session: { auth: { current: { attributes: { team_id: "T1", channel_id: channelId, trust_checked: "true", oe_grain: "task" }, principalId: "U_HUMAN", principalType: "slack-user" } } },
  };
}
const ctxFast = ctxFor("C_FAST");
const ctxEng = ctxFor("C_ENG");

process.env.SLACK_BOT_TOKEN = "xoxb-test";
let cardPosts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  cardPosts++;
  return { ok: true, status: 200, json: async () => ({ ok: true, ts: "1700000000.0001" }) };
}) as unknown as typeof fetch;
try {

{
  const res = await createSkill.execute({ name: "fast-runbook", content: "# Fast\nDo it." }, ctxFast);
  ok(res.autoApproved === true && res.pending === false, "create_skill/lowered: reports autoApproved, NOT pending");
  const msg = String(res.message);
  ok(!msg.includes("card posted"), "create_skill/lowered: the reply does not claim a card was posted");
  ok(msg.startsWith("done — "), `create_skill/lowered: the reply opens with the outcome, not a proposal ("${msg.slice(0, 40)}…")`);
  ok(msg.includes("custom:fastlane-lower"), "create_skill/lowered: the reply NAMES the element that lowered the verb");
  ok(msg.includes("no card was posted") && msg.includes("ALREADY run"), "create_skill/lowered: the reply states both corrections (no card; already ran)");
  ok(msg.includes('skill "fast-runbook"'), "create_skill/lowered: the reply still says WHAT was done, in the tool's own voice");
  ok(msg.includes("the agent follows it from its next turn"), "create_skill/lowered: the reply carries the ActionKind's own outcome line");
  ok(msg.includes("Tell the user"), "create_skill/lowered: the reply asks to be relayed (with no card, it is the ONLY report the asker can get)");
  ok(cardPosts === 0, `auto-approve posts NO card at all (${cardPosts} posts)`);

  const rows = await getOperationalStore().listDomainSkills("default", "fastlane");
  ok(rows.some((r) => r.name === "fast-runbook"), "create_skill/lowered: the skill was actually WRITTEN (the frozen args executed)");
  const decided = await getOperationalStore().getPendingAction("default", String(res.pendingId));
  ok(decided !== null && decided.status === "approved" && decided.decidedBy === "chain:custom:fastlane-lower", "create_skill/lowered: the wedge row is decided by the chain, never a human");
}

{
  const res = await deleteSkill.execute({ name: "fast-runbook" }, ctxFast);
  ok(res.autoApproved === true && res.pending === false, "delete_skill/lowered: reports autoApproved, NOT pending");
  const msg = String(res.message);
  ok(!msg.includes("card posted") && !msg.includes("awaiting a human"), "delete_skill/lowered: no card claim, no waiting-on-a-human claim");
  ok(msg.includes('delete of skill "fast-runbook"') && msg.includes("custom:fastlane-lower"), "delete_skill/lowered: says what was deleted and who lowered it");
  ok(msg.includes("skill fast-runbook deleted from fastlane"), "delete_skill/lowered: carries skill.delete's own outcome line");
  ok((await getOperationalStore().listDomainSkills("default", "fastlane")).every((r) => r.name !== "fast-runbook"), "delete_skill/lowered: the skill is actually GONE");
  ok(cardPosts === 0, "auto-approve still posts no card on the second tool");
}

{
  const res = await createSkill.execute({ name: "eng-runbook", content: "# Eng\nDo it." }, ctxEng);
  ok(res.autoApproved === undefined, "create_skill/ask: no autoApproved key on the ordinary card path");
  ok(res.pending === true && typeof res.pendingId === "string", "create_skill/ask: still returns a pending");
  const msg = String(res.message);
  ok(msg === `card posted — skill "eng-runbook" (created) awaiting a human to arm it (pending ${res.pendingId}).` + PROPOSER_DECISION_NOTE, `create_skill/ask: the card-path text is unchanged apart from the OPE-2071 decision note ("${msg}")`);
  ok(cardPosts === 1, `create_skill/ask: exactly one card was posted (${cardPosts})`);
  ok((await getOperationalStore().listDomainSkills("default", "eng")).length === 0, "create_skill/ask: NOTHING was written — a card is a proposal, not an act");
}

{
  const line = autoApprovedNote("doing the thing", { outcome: "the thing is done", resolvedBy: "mode:DANGEROUSLY_BYPASS" });
  ok(line.startsWith("done — doing the thing:"), "autoApprovedNote: leads with the caller's own subject phrase");
  ok(line.includes("mode:DANGEROUSLY_BYPASS") && line.includes("the thing is done"), "autoApprovedNote: relays both the resolver and the outcome");
  ok(!line.includes("\n"), "autoApprovedNote: stays one line (it is spoken into a chat message)");
}

{
  const dir = fileURLToPath(new URL("../agent/tools/", import.meta.url));
  const proposers: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts")) continue;
    const src = readFileSync(join(dir, f), "utf8");
    if (!/await requestApproval\(/.test(src)) continue;
    proposers.push(f);
    ok(src.includes("posted.autoApproved"), `${f}: branches on the chain's auto-approved result`);
    ok(src.includes("autoApprovedNote("), `${f}: relays it through the shared reply helper`);
    const schema = src.slice(src.indexOf("outputSchema: z.object({"), src.indexOf("}),", src.indexOf("outputSchema: z.object({")));
    ok(schema.includes("autoApproved:"), `${f}: DECLARES autoApproved on its outputSchema (an undeclared key is one the model may never be shown)`);
  }
  ok(proposers.length >= 21, `the sweep saw every propose tool (${proposers.length} found)`);

  const cmds = readFileSync(fileURLToPath(new URL("../agent/commands/core.ts", import.meta.url)), "utf8");
  ok((cmds.match(/posted\.autoApproved/g) ?? []).length >= 2, "commands/core.ts: both budget commands branch on the auto-approved result");
}

console.log(`✓ auto-approved-reply: ${passed} assertions — two real tools replying under a config-lowered verb (named element, no card claim, the kind's own outcome, the mutation actually applied), the unchanged ask-path control, the helper's shape, and the all-propose-tools sweep`);
await removeTempDir(tmp);
} finally {
  globalThis.fetch = realFetch;
}
