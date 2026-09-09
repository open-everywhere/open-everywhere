import { strict as assert } from "node:assert";
import { auditQueries, findAuditQueryDefects, docFiles } from "./audit-query-docs-lint.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let checks = 0;
function ok(condition: boolean, what: string): void {
  assert.ok(condition, what);
  checks += 1;
}

const one = (text: string) => findAuditQueryDefects(new Map([["fixture.md", text]]));

const wrongName = one("Read it with `GET /control/v1/audit?since=<iso>&action=read.refused`.");
ok(wrongName.length === 1, "a query spelling the filter `action` is refused");
ok(wrongName[0]!.problem.includes("`actions`"), "…and the refusal names the parameter the route reads");

const noSince = one("Read it with `GET /control/v1/audit?actions=read.refused`.");
ok(noSince.length === 1, "a query carrying no `since` is refused");
ok(noSince[0]!.problem.includes("400"), "…and the refusal says what the route answers");

ok(one("Read it with `GET /control/v1/audit?since=<iso>&actions=read.refused`.").length === 0, "the spelling the route accepts is clean");
ok(one("`GET /control/v1/audit?since=<iso>&platform=linear&actions=linear.token_mint_failed`").length === 0, "a third parameter between the two required ones is clean");

ok(one("`/control/v1/audit?action=read.refused`").length === 2, "a query that is wrong twice reports twice");

ok(auditQueries("`GET /control/v1/audit?since=<iso>&actions=a` and `/control/v1/audit?since=<iso>`").length === 2, "the scanner finds every audit query in one document");
ok(auditQueries("nothing here").length === 0, "…and finds none where there are none");
ok(
  auditQueries("`GET /control/v1/audit?since=<one hour ago, ISO-8601>&actions=a`")[0] === "since=<one hour ago, ISO-8601>&actions=a",
  "a placeholder carrying spaces and a comma stays inside the query — the angle brackets are the manual's own, not a terminator",
);
ok(auditQueries("(see `/control/v1/audit?since=<iso>`)")[0] === "since=<iso>", "a backtick ends a query, so the prose around it is not read as parameters");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
ok(docFiles(root).length > 20, "docFiles finds the manual — an empty list would green the lint vacuously");
ok(docFiles(root).every((f) => f.startsWith("docs/") && f.endsWith(".md")), "…and every entry is a repo-relative docs markdown path");

console.log(`✓ audit-query-docs-lint-test: ${checks} assertions passed`);
