import {
  classifyConnectorOp,
  connectorOpName,
  isConnectorOpTool,
} from "../agent/access/consequence.js";
import { connectorOpApproval, connectorApprovalPolicy } from "../agent/connections/connector-auth.js";
import { registerSettings, resetSettingsForTest } from "../agent/settings/settings.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

ok(isConnectorOpTool("notion__search"), "isConnectorOpTool true for a qualified op");
ok(!isConnectorOpTool("reply"), "isConnectorOpTool false for a bare tool name");
ok(!isConnectorOpTool("read_notion_page"), "isConnectorOpTool false for a single-underscore authored tool");
ok(connectorOpName("notion__create_page") === "create_page", "connectorOpName strips the connection prefix");
ok(connectorOpName("bare") === "bare", "connectorOpName returns the whole name when unqualified");

for (const op of ["notion__search", "notion__list_databases", "linear__get_issue", "gh__read_file", "x__query", "y__find", "z__describe_page", "a__fetch", "b__view_doc", "c__retrieve"]) {
  ok(classifyConnectorOp(op) === "open", `read op ${op} → open`);
}

for (const op of ["notion__create_page", "notion__update_page", "notion__append_block", "linear__create_issue", "gh__delete_branch", "x__post_message", "y__set_property", "z__move_card", "a__archive_page", "b__comment"]) {
  ok(classifyConnectorOp(op) === "gate:member", `write op ${op} → gate:member`);
}

ok(classifyConnectorOp("notion__frobnicate_widget") === "gate:member", "unknown verb → gate:member (fail-safe to gated)");
ok(classifyConnectorOp("notion__") === "gate:member", "empty op → gate:member (fail-safe)");

ok(classifyConnectorOp("notion__notion-fetch") === "open", "vendor-prefixed read (notion__notion-fetch) → open");
ok(classifyConnectorOp("notion__notion-search") === "open", "vendor-prefixed read (notion__notion-search) → open");
ok(classifyConnectorOp("notion__notion-create-pages") === "gate:member", "vendor-prefixed write (notion__notion-create-pages) → gate:member");
ok(classifyConnectorOp("notion__notionette") === "gate:member", "prefix strip requires a separator — notionette is not stripped (fail-safe)");

const approve = connectorOpApproval();
const noneApproved = new Set<string>();
ok(approve({ toolName: "notion__search", approvedTools: noneApproved } as never) === "not-applicable", "read op → not-applicable (no prompt)");
ok(approve({ toolName: "notion__create_page", approvedTools: noneApproved } as never) === "user-approval", "unapproved write → user-approval (prompt)");
const oneApproved = new Set<string>(["notion__create_page"]);
ok(approve({ toolName: "notion__create_page", approvedTools: oneApproved } as never) === "not-applicable", "already-approved write → not-applicable (once-per-op)");
ok(approve({ toolName: "notion__delete_page", approvedTools: oneApproved } as never) === "user-approval", "a DIFFERENT write still prompts (approval is per-op, not blanket)");
ok(approve({ toolName: "notion__delete_page", approvedTools: new Set<string>(["notion__delete_page"]) } as never) === "user-approval", "an already-approved DESTRUCTIVE op STILL prompts (per-call, OPE-11)");

resetSettingsForTest();
{
  const off = connectorApprovalPolicy().request;
  const read = await off({ toolName: "notion__search", approvedTools: new Set<string>() } as never);
  ok(read !== "not-applicable", "flag OFF → once(): an unapproved READ is not auto-allowed (blanket policy)");
}
registerSettings({ connectors: { opTiering: true } });
{
  const on = connectorApprovalPolicy().request;
  ok((await on({ toolName: "notion__search", approvedTools: new Set<string>() } as never)) === "not-applicable", "flag ON → tiered: a READ is auto-allowed");
  ok((await on({ toolName: "notion__create_page", approvedTools: new Set<string>() } as never)) === "user-approval", "flag ON → tiered: a WRITE prompts");
}
resetSettingsForTest();

console.log(`✓ connector-op-tier: ${passed} assertions passed`);
