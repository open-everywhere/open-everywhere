export const STAND_DOWN_DIRECT_POSTS: readonly string[] = [
  "postUnifiedReply(",
  "postReply(",
  "postHostNotice",
  ".postText(",
  "postSurfaceText",
  "editSurfaceText(",
  "setSurfaceReaction(",
  ".dispatchReply(",
  ".dispatchUnified(",
  ".react(",
  ".postFiles(",
  "postFilesTo",
  "editPostedMessage(",
  ".editMessage(",
  "setReaction(",
  "chat.postMessage",
  "chat.update",
  "reactions.add",
];

const STAND_DOWN_APPROVAL_CARD_RE = /\brequestApproval\s*\(/;

const STAND_DOWN_GATE_CALLS: readonly string[] = [
  "refuseVerbIfStoodDown(",
  "refuseTargetIfStopped(",
  "withholdIfStoodDown(",
  "boundStandDownState(",
  "standDownState(",
];

export type StandDownPostKind = "direct" | "approval-card";

export interface StandDownUngated {
  readonly file: string;
  readonly kind: StandDownPostKind;
  readonly why: "by-design" | "open";
  readonly reason: string;
}

const APPROVALS_OPEN = "OPE-2816: an approval card or an auto-approved run does not read the stand-down gate yet.";

const APPROVAL_CARD_TOOLS: readonly string[] = [
  "add_routine_rule",
  "assign",
  "cancel_routine",
  "clear_connector_override",
  "clear_spend_limit",
  "create_agent",
  "create_routine",
  "create_skill",
  "create_ticket",
  "declare_webhook",
  "delegate_to_agent",
  "delete_skill",
  "dm_person",
  "edit_routine",
  "enable_routine",
  "meeting_join",
  "meeting_recap",
  "my_browser",
  "my_browser_handoff",
  "open_pull_request",
  "post_message",
  "propose_email_sender",
  "propose_mcp_server",
  "purge_memory",
  "remove_routine_rule",
  "request_access",
  "resume",
  "revoke_connector",
  "rotate_webhook",
  "set_spend_limit",
  "set_state",
  "update_list",
  "write_canvas",
];

const DM_ONLY = "It posts only into a 1:1 DM, and `stand_down` refuses a DM, so no stop can apply.";

export const STAND_DOWN_UNGATED: readonly StandDownUngated[] = [
  { file: "packages/core/agent/tools/answer_domain_question.ts", kind: "direct", why: "by-design", reason: `${DM_ONLY} The answer goes to the asker's own DM (a domain question is asked from a DM only).` },
  { file: "packages/core/agent/tools/confirm_link.ts", kind: "direct", why: "by-design", reason: `${DM_ONLY} The tool refuses any mode other than \`dm\`.` },
  { file: "packages/core/agent/tools/link_identity.ts", kind: "direct", why: "by-design", reason: `${DM_ONLY} The tool refuses any mode other than \`dm\`.` },
  { file: "packages/core/agent/tools/my_browser.ts", kind: "direct", why: "by-design", reason: `${DM_ONLY} The watch link goes to the browser owner's DM.` },
  { file: "packages/core/agent/tools/my_browser_handoff.ts", kind: "direct", why: "by-design", reason: `${DM_ONLY} The hand-off link goes to the browser owner's DM.` },
  {
    file: "packages/core/agent/tools/post_pr_walkthrough.ts",
    kind: "direct",
    why: "by-design",
    reason: "It posts a top-level Slack message into the configured governance admin channel. Slack has no room grain, and a top-level post sits in no thread, so no stop can apply.",
  },
  ...APPROVAL_CARD_TOOLS.map((t): StandDownUngated => ({ file: `packages/core/agent/tools/${t}.ts`, kind: "approval-card", why: "open", reason: APPROVALS_OPEN })),
];

export interface StandDownGateFile {
  readonly file: string;
  readonly source: string;
}

function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function kindsIn(code: string): StandDownPostKind[] {
  const kinds: StandDownPostKind[] = [];
  if (STAND_DOWN_DIRECT_POSTS.some((p) => code.includes(p))) kinds.push("direct");
  if (STAND_DOWN_APPROVAL_CARD_RE.test(code)) kinds.push("approval-card");
  return kinds;
}

export function callsStandDownGate(source: string): boolean {
  const code = codeOf(source);
  return STAND_DOWN_GATE_CALLS.some((g) => code.includes(g));
}

export function checkStandDownGateSites(files: readonly StandDownGateFile[], ungated: readonly StandDownUngated[] = STAND_DOWN_UNGATED): string[] {
  const problems: string[] = [];
  const listed = new Map<string, StandDownUngated>();
  for (const u of ungated) {
    const key = `${u.file}#${u.kind}`;
    if (listed.has(key)) problems.push(`${u.file} — listed twice for kind "${u.kind}" in STAND_DOWN_UNGATED`);
    if (u.reason.trim().length === 0) problems.push(`${u.file} — its STAND_DOWN_UNGATED entry gives no reason`);
    listed.set(key, u);
  }
  const used = new Set<string>();
  for (const f of files) {
    const code = codeOf(f.source);
    const gated = STAND_DOWN_GATE_CALLS.some((g) => code.includes(g));
    for (const kind of kindsIn(code)) {
      const key = `${f.file}#${kind}`;
      const entry = listed.get(key);
      if (entry !== undefined) {
        used.add(key);
        if (kind === "direct" && gated) {
          problems.push(`${f.file} — calls the stand-down gate, so its "direct" entry in STAND_DOWN_UNGATED is stale: delete the entry`);
        }
        continue;
      }
      if (kind === "direct" && gated) continue;
      problems.push(
        kind === "direct"
          ? `${f.file} — posts into a conversation (${STAND_DOWN_DIRECT_POSTS.filter((p) => code.includes(p)).map((p) => p.replace(/\($/, "")).join(", ")}) but never calls the stand-down gate. ` +
              `Call refuseVerbIfStoodDown (or withholdIfStoodDown, or refuseTargetIfStopped) before the post, or add a reviewed STAND_DOWN_UNGATED entry that says why no stop can apply`
          : `${f.file} — raises an approval card (requestApproval) that no stand-down gate reads. Add it to STAND_DOWN_UNGATED under OPE-2816, or gate the card`,
      );
    }
  }
  for (const [key, u] of listed) {
    if (used.has(key)) continue;
    problems.push(
      files.some((f) => f.file === u.file)
        ? `${u.file} — listed in STAND_DOWN_UNGATED for kind "${u.kind}", but it no longer makes that kind of post: delete the stale entry`
        : `${u.file} — listed in STAND_DOWN_UNGATED, but the file is not in the scan: delete the stale entry`,
    );
  }
  return problems;
}
