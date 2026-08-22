process.env.OE_SQLITE_PATH = ":memory:";
process.env.OE_PLATFORM = "slack";
delete process.env.OE_ORG;

import { classifyConnectorOpTier, restMethodTier } from "../agent/access/consequence.js";
import { sessionGrantKind, connectorSessionKind } from "../agent/approvals/session-grant.js";
import { connectorOpApproval } from "../agent/connections/connector-auth.js";

const { registerConfig } = await import("../agent/access/config.js");
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

for (const op of ["notion__search", "notion__get_page", "linear__list_issues", "x__fetch", "y__retrieve", "z__query"]) {
  ok(classifyConnectorOpTier(op) === "read", `read op ${op} → read`);
}
for (const op of ["notion__create_page", "notion__update_page", "notion__append_block", "linear__create_issue", "x__post_message", "y__set_property", "z__archive_page"]) {
  ok(classifyConnectorOpTier(op) === "write", `write op ${op} → write`);
}
for (const op of ["notion__delete_page", "linear__remove_label", "gh__destroy_repo", "x__drop_table", "y__purge_cache", "z__trash_doc", "a__erase_row", "b__wipe_db"]) {
  ok(classifyConnectorOpTier(op) === "destructive", `destructive op ${op} → destructive`);
}
ok(classifyConnectorOpTier("notion__frobnicate_widget") === "destructive", "unknown verb → destructive (fail-closed, never session-skippable)");
ok(classifyConnectorOpTier("notion__") === "destructive", "empty op → destructive (fail-closed)");
ok(classifyConnectorOpTier("notion__unarchive_page") === "write", "unarchive is reversible → write, not destructive");
ok(classifyConnectorOpTier("notion__get_or_create_entity") === "write", "compound get_or_create → write (any write token escalates past a read head)");
ok(classifyConnectorOpTier("slack__check_and_post_message") === "write", "compound check_and_post → write");
ok(classifyConnectorOpTier("linear__list_or_create_labels") === "write", "compound list_or_create → write");
ok(classifyConnectorOpTier("x__get_or_delete_row") === "destructive", "compound with a destructive token → destructive outright");
ok(classifyConnectorOpTier("x__get_delete_marker") === "destructive", "noun-collision over-gates in the SAFE direction (delete token wins even as a noun)");
ok(classifyConnectorOpTier("notion__get_page") === "read", "plain read with noun tokens stays read (unrecognised tokens don't drag to destructive when a read verb is present)");

ok(restMethodTier("GET") === "read", "GET → read");
ok(restMethodTier("head") === "read", "HEAD (case-insensitive) → read");
ok(restMethodTier("OPTIONS") === "read", "OPTIONS → read");
ok(restMethodTier("POST") === "write", "POST → write");
ok(restMethodTier("PUT") === "write", "PUT → write");
ok(restMethodTier(" patch ") === "write", "PATCH (trimmed/cased) → write");
ok(restMethodTier("DELETE") === "destructive", "DELETE → destructive");
ok(restMethodTier("TRACE") === "destructive", "an unknown method → destructive (fail-closed)");
ok(restMethodTier("") === "destructive", "an empty method → destructive (fail-closed)");

ok(connectorSessionKind("notion") === "connector.op:notion", "connectorSessionKind is per-connector");
ok(sessionGrantKind({ kind: "pr.open", argsJson: "{}" }) === "pr.open", "pr.open is always grantable → memo kind pr.open");
ok(sessionGrantKind({ kind: "create_skill", argsJson: "{}" }) === null, "an injection gate (create_skill) is NOT grantable");
ok(sessionGrantKind({ kind: "spend.set", argsJson: "{}" }) === null, "an admin gate (spend.set) is NOT grantable");
ok(sessionGrantKind({ kind: "connector.op:notion", argsJson: "{}" }) === null, "the raw per-connector memo kind itself is NOT a grantable PROPOSAL kind (no tool proposes it; no live transport consults it since OPE-372)");

{
  const approve = connectorOpApproval();
  ok(approve({ toolName: "notion__search", approvedTools: new Set<string>() } as never) === "not-applicable", "read never prompts");
  const approvedWrite = new Set<string>(["notion__create_page"]);
  ok((await approve({ toolName: "notion__create_page", approvedTools: approvedWrite } as never)) === "not-applicable", "an already-approved WRITE is silenced (once-per-op)");
  const approvedDelete = new Set<string>(["notion__delete_page"]);
  ok((await approve({ toolName: "notion__delete_page", approvedTools: approvedDelete } as never)) === "user-approval", "a DESTRUCTIVE op prompts PER CALL even when already approved (never honours the memo)");
  ok((await approve({ toolName: "notion__delete_page", approvedTools: new Set<string>() } as never)) === "user-approval", "an unapproved destructive op prompts");
}

console.log(`✓ connector-approval-model: ${passed} assertions passed (tier + REST map + session-grant + destructive-per-call)`);
