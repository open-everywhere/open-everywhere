import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-egress-spoof-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });
delete process.env.OE_EGRESS_SPOOF;
delete process.env.VERCEL;
delete process.env.OE_PLATFORM;

import { overrideSettingsForTest } from "../agent/settings/settings.js";
import type { SurfaceMessageOps } from "../agent/channels/surface-message-ops.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

overrideSettingsForTest({ approvals: { judgeMode: "off" } });

const { registerConfig } = await import("../agent/access/config.js");
const { requestApproval, registerJudgeLiftNoticePoster } = await import("../agent/approvals/flow.js");
const { registerApprovalJudgeCompletion, clearApprovalJudgeVerdictCache } = await import("../agent/access/approval-judge.js");
const { registerSurfaceMessageOps, setSurfaceReaction } = await import("../agent/channels/surface-message-ops.js");
const { readAudit } = await import("../agent/audit/audit.js");

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
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [{ name: "plain", reach: ["discord/G1/C1"] }],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

let noticePosts = 0;
registerJudgeLiftNoticePoster("discord", async () => {
  noticePosts++;
});

let reactions = 0;
const countingOps: SurfaceMessageOps = {
  platform: "discord",
  async postText() {
    return "m-1";
  },
  async editMessage() {},
  async setReaction() {
    reactions++;
  },
};
registerSurfaceMessageOps(countingOps);

function armAllowingJudge(): void {
  clearApprovalJudgeVerdictCache();
  registerApprovalJudgeCompletion(async (_prompt, pass) => (pass === "scrutiny" ? "YES" : "VERDICT: allow\nREASON: modest cap, attended, clean turn"));
}

overrideSettingsForTest({ approvals: { judgeMode: "enforce" } });

let cap = 500_000;
function liftInput(): Record<string, unknown> {
  cap += 1_000;
  return {
    org: "test-org",
    kind: "spend.set",
    channelId: "C1",
    requestedBy: "U_HUMAN",
    threadTs: null,
    scopeKey: "discord/G1/C1",
    postedTo: "discord/G1/C1",
    domain: "plain",
    args: { org: "test-org", scopeKey: "discord/G1/C1", level: "surface", monthlyTokens: cap, currentCap: null },
    chain: { unattended: false },
  };
}

async function autoApprovedRows(): Promise<unknown[]> {
  return (await readAudit({ org: "test-org" })).filter((r) => r.action === "approval.autoapproved");
}

{
  armAllowingJudge();
  delete process.env.OE_EGRESS_SPOOF;
  const res = await requestApproval(liftInput() as never, {});
  ok(res.autoApproved?.resolvedBy === "judge", "1a. NEGATIVE CONTROL: the judge lifted the gated verb (no card, the frozen args ran)");
  ok(noticePosts === 1, "1b. NEGATIVE CONTROL: …and the registered notice poster was REALLY called — the room got the notice");
  ok((await autoApprovedRows()).length === 1, "1c. NEGATIVE CONTROL: the lift wrote its approval.autoapproved row");
}

{
  armAllowingJudge();
  noticePosts = 0;
  process.env.OE_EGRESS_SPOOF = "1";
  const res = await requestApproval(liftInput() as never, {});
  ok(res.autoApproved?.resolvedBy === "judge", "2a. spoofed: the judge still lifts — the flag swallows posts, not work");
  ok(noticePosts === 0, "2b. 🔴 spoofed: the judge-lift notice reached NO vendor transport (the registered poster was never called)");
  ok((await autoApprovedRows()).length === 2, "2c. spoofed: the lift still wrote its approval.autoapproved row, so an eval can still score the act");
  delete process.env.OE_EGRESS_SPOOF;
}

{
  reactions = 0;
  delete process.env.OE_EGRESS_SPOOF;
  const live = await setSurfaceReaction("discord", { channelId: "C1", messageId: "m1" }, { slackName: "raised_hand", unicode: "✋" }, true);
  ok(live && reactions === 1, "3a. NEGATIVE CONTROL: no flag ⇒ the registered reaction arm was REALLY called");

  reactions = 0;
  process.env.OE_EGRESS_SPOOF = "1";
  const spoofed = await setSurfaceReaction("discord", { channelId: "C1", messageId: "m1" }, { slackName: "raised_hand", unicode: "✋" }, true);
  ok(reactions === 0, "3b. 🔴 spoofed: the reaction reached NO vendor transport");
  ok(spoofed === true, "3c. spoofed: …and it still reports TRUE, so placeStopHand's handPlaced tally reads the same under eval as on a live surface");
  delete process.env.OE_EGRESS_SPOOF;
}

{
  reactions = 0;
  process.env.OE_EGRESS_SPOOF = "1";
  process.env.VERCEL = "1";
  let threw = "";
  try {
    await setSurfaceReaction("discord", { channelId: "C1", messageId: "m1" }, { slackName: "raised_hand", unicode: "✋" }, true);
  } catch (e) {
    threw = String(e);
  }
  ok(/OE_EGRESS_SPOOF is a local-eval flag — refusing on Vercel\./.test(threw), "4a. the Vercel refusal PROPAGATES out of setSurfaceReaction rather than being caught as a transport failure");
  ok(reactions === 0, "4b. …and it fires before the vendor arm is ever reached");
  delete process.env.VERCEL;
  delete process.env.OE_EGRESS_SPOOF;
}

{
  const { registerSlackBridge, _resetSlackBridgeForTest, bridgeSlackForm, bridgeSlackReadCall } = await import("../agent/channels/slack-bridge.js");
  const methods: string[] = [];
  registerSlackBridge({
    async form(method: string) {
      methods.push(method);
      return { ok: true, ts: "1724.0001" };
    },
    async readCall(operation: string) {
      methods.push(operation);
      return { ok: true, ts: "1724.0002" };
    },
  } as never);

  delete process.env.OE_EGRESS_SPOOF;
  await bridgeSlackForm("chat.postMessage", "channel=C1&text=hi");
  await bridgeSlackReadCall("reactions.add", { channel: "C1", name: "eyes", timestamp: "1724.0001" });
  ok(methods.length === 2, "4b-a. NEGATIVE CONTROL: no flag ⇒ both Slack writes REALLY reached the registered bridge");

  methods.length = 0;
  process.env.OE_EGRESS_SPOOF = "1";
  const posted = await bridgeSlackForm("chat.postMessage", "channel=C1&text=hi");
  const reacted = await bridgeSlackReadCall("reactions.add", { channel: "C1", name: "eyes", timestamp: "1724.0001" });
  ok(methods.length === 0, "4b-b. 🔴 spoofed: NEITHER Slack write reached the bridge — a card/notice with no spine of its own is covered too");
  ok(posted?.ok === true && typeof posted["ts"] === "string", "4b-c. spoofed: chat.postMessage answers Slack's own success shape, so a caller reading `res.ts` is unchanged");
  ok(reacted.ok === true, "4b-d. spoofed: the fail-loud read-call arm answers ok too, rather than throwing 'no Slack provider'");

  await bridgeSlackForm("users.info", "user=U1");
  ok(methods.length === 1 && methods[0] === "users.info", "4b-e. 🔴 spoofed: a READ still reaches Slack — the gate is a write ALLOWLIST, never a 'not a read' guess");

  delete process.env.OE_EGRESS_SPOOF;
  _resetSlackBridgeForTest();
}

{
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, relative, sep } = await import("node:path");
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const readers: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === "scripts") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts") && readFileSync(full, "utf8").includes("process.env.OE_EGRESS_SPOOF")) readers.push(relative(repoRoot, full));
    }
  };
  for (const root of ["packages/core/agent", "packages/providers"]) walk(join(repoRoot, root));
  const gate = ["packages", "core", "agent", "channels", "egress-spoof.ts"].join(sep);
  const offenders = readers.filter((f) => f !== gate);
  ok(offenders.length === 0, `5a. only channels/egress-spoof.ts reads process.env.OE_EGRESS_SPOOF in product code — offenders: ${offenders.join(", ") || "(none)"}`);
  ok(readers.length === 1, "5b. …and the gate IS one of them (a moved or renamed gate would otherwise pass 5a vacuously)");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`✓ egress-spoof (OPE-1132) — ${passed} assertions (the judge-lift notice and the reaction now take the shared exit; negative controls prove both really post without the flag)`);
