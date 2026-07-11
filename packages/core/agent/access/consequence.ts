export type ConsequenceTier = "open" | "gate:member" | "gate:admin";

export type GatingMechanism =
  | { readonly kind: "none" }
  | { readonly kind: "action-kind"; readonly action: string }
  | { readonly kind: "admin-roles" }
  | { readonly kind: "eve-hitl" };

export interface ConsequenceEntry {
  readonly tier: ConsequenceTier;
  readonly via: GatingMechanism;
  readonly reason: string;
}

const open = (reason: string): ConsequenceEntry => ({ tier: "open", via: { kind: "none" }, reason });
const member = (action: string, reason: string): ConsequenceEntry => ({ tier: "gate:member", via: { kind: "action-kind", action }, reason });
const admin = (action: string, reason: string): ConsequenceEntry => ({ tier: "gate:admin", via: { kind: "action-kind", action }, reason });

export const TOOL_CONSEQUENCE: Readonly<Record<string, ConsequenceEntry>> = {
  bash: open("sandbox execution; reach is bounded by the egress plane (L1), not by this table"),
  glob: open("sandbox-local file listing"),
  grep: open("sandbox-local file search"),
  read_file: open("sandbox-local read"),
  write_file: open("sandbox-local write — durable effects leave only via gated verbs"),

  web_search: open("read of the public web via eve's provider; a read, escapes nothing"),
  ask_question: open("asks the ROOM a clarifying question — stays in the asking conversation"),
  todo: open("in-context scratchpad for the model's own turn planning; nothing durable, nothing leaves"),
  load_skill: open("loads a skill's instructions INTO CONTEXT — reading a procedure, not executing an effect; arming a skill stays gated at create_skill"),
  connection_search: open("read of WHICH connectors exist for this session; a connector's own OPERATIONS are the separate design-deferred plane (§3 grain 2)"),

  check_pr_status: open("read of a PR's state"),
  checkout_repo: open("read into the sandbox with a read-only credential; the write path is open_pull_request"),
  describe_image: open("read/vision over an attachment already in the room"),
  list_repos: open("read of this channel's own grant"),
  list_routines: open("read of this surface's own routines"),
  list_skills: open("read of the domain's own skills"),
  read_notion_page: open("granted read; disclosure is bounded by the room-level grant (membership is the ACL)"),
  read_slack_channel: open("read of a channel the bot is already in, into that conversation"),
  read_slack_thread: open("same-surface thread read"),
  session_cost: open("read of this session's own spend"),
  spend_report: open("aggregate read; the org-wide scope additionally requires org-admin inside spend/reporting.ts's resolveReportScope"),
  usage_report: open("aggregate read; same shared resolveReportScope gate as spend_report for org scope"),
  web_fetch: open("read via the egress allowlist; default-deny hosts bound what it can reach"),

  no_reply: open("ends the turn silently; posts nothing"),
  react: open("an emoji in the asking room"),
  reply: open("a visible, ordinary reply in the asking room — same class as the terminal text it replaces; audited"),
  update_reply: open("silent edit of the bot's own message in the asking room; audited"),
  update_status: open("ephemeral status line in the asking room"),
  browser_qa: open("screenshots the agent's own workspace UI and posts them into the asking thread"),
  post_file: {
    tier: "open",
    via: { kind: "eve-hitl" },
    reason:
      "posts a file into the asking room (same class as reply). The input-aware eve confirmation on the " +
      "HTML-artifact publish path is a session-private UX confirm, not an authorization gate — blessed as " +
      "the eve-HITL residue by design §7.2 (the artifact URL is org-opt-in and unlisted).",
  },

  cancel_routine: member("routine.cancel", "behaviour-persisting removal: silently cancelling a watch/schedule removes a guardrail the surface relies on; reversible by re-creation, but a human confirms"),
  delete_skill: member("skill.delete", "behaviour-persisting removal: silently deleting a shared domain skill/runbook removes a guardrail; reversible by re-creation, but a human confirms"),

  record_watch_state: open("writes watch bookkeeping onto the calling routine's OWN row, located via the dispatcher-stamped marker"),
  subscribe_pr: open("arms a self-serve check-back that posts into this same surface; cancellable with cancel_routine"),
  extend_workspace_time: open("extends this session's own sandbox window; capped (OE_SANDBOX_EXTEND_MAX_MIN) and audited"),

  create_skill: member("skill.create", "self-modification: a skill is a procedure the agent will load and FOLLOW by name (persistent RCE-of-behaviour)"),
  create_routine: member("routine.create", "self-modification: a standing scheduled behaviour that outlives the turn"),
  remember: member(
    "memory.remember",
    "self-modification, CONDITIONAL: a plain fact writes directly (not consequential); a standing RULE or any fact from a tainted turn freezes onto a card",
  ),
  forget: member("memory.forget", "hard-to-reverse: destroys memory (and the frozen args carry only the bullet's hash — GDPR redaction)"),
  open_pull_request: member(
    "pr.open",
    "audience-expanding: a PR reaches repo watchers, CI and reviewers beyond the asking room; commits stage on a hidden ref and publish only on the click",
  ),
  request_access: member("access.request", "audience-expanding: sends a grant request (a bot PR + admin-channel note) beyond the asking room; the merge stays the privilege gate"),

  set_spend_limit: admin("spend.set", "self-modification + money: changes what the org will spend"),
  clear_spend_limit: admin("spend.clear", "reverts a spend control — same bar as setting one"),
  revoke_connector: admin("connector.revoke", "kills a live capability for a scope — an org-level control change"),
  clear_connector_override: admin("connector.clear", "re-arms a revoked capability — same bar as the revoke"),
  memory_admin_list: {
    tier: "gate:admin",
    via: { kind: "admin-roles" },
    reason: "audience-expanding read: enumerates silos beyond this room's own memory — role-scoped disclosure (access/roles.ts adminControlRoles)",
  },
  memory_admin_read: {
    tier: "gate:admin",
    via: { kind: "admin-roles" },
    reason: "audience-expanding read: pulls another room's silo contents into this one — role-scoped disclosure",
  },
};

export interface ToolSource {
  readonly name: string;
  readonly source: string;
}

const REQUEST_APPROVAL = /\brequestApproval\s*\(/;
const ADMIN_ROLES = /\brequireOrgAdmin\s*\(|\brequireDomainAdminOrOrg\s*\(|\badminControlRoles\s*\(/;
const EVE_HITL = /^\s*approval:(?!\s*never\()/m;

export function checkConsequenceRegistry(
  tools: readonly ToolSource[],
  frameworkToolNames: readonly string[],
  policyOf: (action: string) => "admin" | "member" | undefined,
  registry: Readonly<Record<string, ConsequenceEntry>> = TOOL_CONSEQUENCE,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const authored = new Set(tools.map((t) => t.name));

  for (const tool of tools) {
    seen.add(tool.name);
    const entry = registry[tool.name];
    if (!entry) {
      problems.push(
        `tool "${tool.name}" has NO consequence declaration — add it to access/consequence.ts's TOOL_CONSEQUENCE (there is deliberately no default tier)`,
      );
      continue;
    }

    const hasPropose = REQUEST_APPROVAL.test(tool.source);
    const hasRoles = ADMIN_ROLES.test(tool.source);
    const hasHitl = EVE_HITL.test(tool.source);

    switch (entry.via.kind) {
      case "none":
        if (entry.tier !== "open") {
          problems.push(`tool "${tool.name}" declares ${entry.tier} with NO gating mechanism — an under-gated declaration; wire a gate or re-tier it`);
        }
        if (hasPropose || hasRoles || hasHitl) {
          problems.push(
            `tool "${tool.name}" is declared open/ungated but its source carries a gating construct (${[hasPropose && "requestApproval", hasRoles && "admin-roles check", hasHitl && "eve approval:"].filter(Boolean).join(", ")}) — update its TOOL_CONSEQUENCE row so the change is a visible diff`,
          );
        }
        break;
      case "action-kind": {
        if (!hasPropose) {
          problems.push(`tool "${tool.name}" declares ${entry.tier} via ActionKind "${entry.via.action}" but its source never calls requestApproval — the gate is not actually wired (under-gated)`);
        }
        if (!tool.source.includes(`"${entry.via.action}"`)) {
          problems.push(`tool "${tool.name}" declares ActionKind "${entry.via.action}" but its source never names that kind — the registry row points at a gate the tool doesn't use`);
        }
        const policy = policyOf(entry.via.action);
        if (policy === undefined) {
          problems.push(`tool "${tool.name}" declares ActionKind "${entry.via.action}" but no such kind is registered (approvals/actions.ts) — the propose would throw at runtime`);
        } else {
          const expected = entry.tier === "gate:admin" ? "admin" : entry.tier === "gate:member" ? "member" : null;
          if (expected === null) {
            problems.push(`tool "${tool.name}" declares tier "open" via an ActionKind — a gated mechanism needs a gate:* tier`);
          } else if (policy !== expected) {
            problems.push(
              `tool "${tool.name}" declares ${entry.tier} but ActionKind "${entry.via.action}" registers ApproverPolicy "${policy}" — the declaration and the runtime gate disagree`,
            );
          }
        }
        break;
      }
      case "admin-roles":
        if (entry.tier !== "gate:admin" && entry.tier !== "open") {
          problems.push(`tool "${tool.name}" declares ${entry.tier} via admin-roles — that mechanism enforces admin standing, so the tier must be gate:admin (or open for a partial, in-tool check)`);
        }
        if (!hasRoles) {
          problems.push(`tool "${tool.name}" declares an admin-roles gate but its source has no requireOrgAdmin/requireDomainAdminOrOrg/adminControlRoles call (under-gated)`);
        }
        break;
      case "eve-hitl":
        if (entry.tier !== "open") {
          problems.push(
            `tool "${tool.name}" declares ${entry.tier} via eve-hitl — eve HITL has no approver-standing check, so it cannot carry a gate:* tier (design §7.2); route it through an ActionKind`,
          );
        }
        if (!hasHitl) {
          problems.push(`tool "${tool.name}" declares eve-hitl but its source sets no non-never \`approval:\` policy — the confirmation is not actually wired`);
        }
        break;
    }
  }

  for (const name of frameworkToolNames) {
    if (authored.has(name)) continue;
    seen.add(name);
    const entry = registry[name];
    if (!entry) {
      problems.push(
        `framework tool "${name}" is mounted by eve at runtime but has NO consequence declaration — add it to access/consequence.ts's TOOL_CONSEQUENCE (fail-closed: a mounted tool can't be un-tiered)`,
      );
      continue;
    }
    if (!(entry.tier === "open" && entry.via.kind === "none")) {
      problems.push(
        `framework tool "${name}" is declared ${entry.tier}/${entry.via.kind} — a framework tool OE doesn't author has no source to scan and no ActionKind of its own, so it must be open/none. To gate it, ship an agent/tools/${name}.ts override (which moves it onto the scanned path).`,
      );
    }
  }

  for (const name of Object.keys(registry)) {
    if (!seen.has(name)) {
      problems.push(
        `TOOL_CONSEQUENCE registers "${name}" but it is neither an authored tool file nor a mounted framework tool — remove the row or fix the name (a stale row hides a real gap)`,
      );
    }
  }

  return problems;
}
