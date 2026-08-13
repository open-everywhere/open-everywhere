import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-chain-flow-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
delete process.env.OE_ORG;

const { registerConfig } = await import("../agent/access/config.js");
const { requestApproval } = await import("../agent/approvals/flow.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");

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
      ],
    },
  ],
  loadBindings: () => [{ bundle: "org-policy", scope: { level: "org" } }],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [
    { name: "bypassed", channels: ["slack/T1/C_BYPASS"], approvalMode: { mode: "DANGEROUSLY_BYPASS" } },
    { name: "lockdown", channels: ["slack/T1/C_LOCK"], approvalMode: { mode: "DENY_ALL" } },
    { name: "frozen", channels: ["slack/T1/C_FROZEN"] },
    { name: "fastlane", channels: ["slack/T1/C_FAST"] },
    { name: "plain", channels: ["slack/T1/C_PLAIN"] },
    { name: "hookfast", channels: ["slack/T1/C_HOOK"] },
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

type Row = { action: string; detail?: Record<string, unknown> };
async function rowsFor(action: string): Promise<Row[]> {
  return (await readAudit({})).filter((r) => r.action === action) as Row[];
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
  const d = chainRows[0]!.detail ?? {};
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
  const chainRows = await rowsFor("approval.chain");
  const d = chainRows[0]!.detail ?? {};
  ok(d.verdict === "deny" && d.registryVerdict === "ask" && d.denyAbsolute === true, "deny: the row carries BOTH verdicts + the absolute-deny mark");
}

{
  const res = await requestApproval({ ...baseInput, args: argsFor("fastlane"), scopeKey: "slack/T1/C_FAST", domain: "fastlane", channelId: "C_FAST" }, { postCard });
  ok(res.autoApproved !== undefined && res.autoApproved.resolvedBy === "custom:fastlane-lower", "allow: the propose auto-approved, naming the lowering element");
  ok(res.autoApproved!.outcome.includes("nothing to delete"), "allow: the kind's REAL execute ran the frozen args (harmless noop target)");
  const decided = await getOperationalStore().getPendingAction("test-org", res.id);
  ok(decided !== null && decided.status === "approved", "allow: the wedge row exists, status approved");
  ok(decided!.decidedBy === "chain:custom:fastlane-lower", "allow: decidedBy is the chain element, never a human's id");
  const auto = await rowsFor("approval.autoapproved");
  ok(auto.length === 1 && (auto[0]!.detail ?? {}).resolvedBy === "custom:fastlane-lower", "allow: the approval.autoapproved row records the lowering");
}

{
  const res = await requestApproval(
    {
      org: "test-org",
      kind: "webhook.rotate",
      args: { org: "test-org", hookId: "ci-status", posture: "read-only", surfaceKey: "slack/T1/C_HOOK", requestedBy: "U_HUMAN", platform: "slack", channelId: "C_HOOK" },
      scopeKey: "slack/T1/C_HOOK",
      domain: "hookfast",
      channelId: "C_HOOK",
      requestedBy: "U_HUMAN",
      threadTs: null,
    },
    { postCard },
  );
  ok(res.autoApproved === undefined && typeof res.id === "string", "floor: webhook.rotate under the SAME lowering that auto-approves skill.delete instead CARDS");
  const row = (await getOperationalStore().listPendingActions("test-org")).find((r) => r.id === res.id);
  ok(row !== undefined && row.status === "pending", "floor: a pending row awaits a human's click — the mint has NOT happened");
  const auto = await rowsFor("approval.autoapproved");
  ok(!auto.some((r) => (r.detail ?? {}).kind === "webhook.rotate"), "floor: no approval.autoapproved row was ever written for webhook.rotate — execute() did not run");
  const chainRows = await rowsFor("approval.chain");
  const d = (chainRows.find((r) => (r.detail ?? {}).action === "webhook.rotate")?.detail ?? {}) as { verdict?: string; registryVerdict?: string; transforms?: { name: string }[] };
  ok(d.verdict === "ask" && d.registryVerdict === "ask", "floor: the chain row shows ask despite the operator's lowering element existing");
  ok((d.transforms ?? []).some((t) => t.name === "beneficiary-clicker-floor"), "floor: the row names the arrow that refused the lowering — queryable, like every other transform");
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
  const chainRows = await rowsFor("approval.chain");
  const d = chainRows[0]!.detail ?? {};
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

console.log(`✓ approver-chain-flow: ${passed} assertions — ask parity (card + chain row), operator deny (nothing minted), config lowering (frozen args executed, wedge row decided by the chain), unattended fail-fast, BYPASS-as-transform, deny-survives-bypass, DENY_ALL, the non-tool-kind carve-out, and the OPE-310 beneficiary-clicker floor`);
rmSync(tmp, { recursive: true, force: true });
